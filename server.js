const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

function loadEnvironmentFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;

    fs.readFileSync(envPath, "utf8").split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;

        const separator = trimmed.indexOf("=");
        if (separator < 1) return;

        const key = trimmed.slice(0, separator).trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) return;

        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, "").trim();
        }

        process.env[key] = value;
    });
}

loadEnvironmentFile();

const app = express();
const PORT = Number(process.env.PORT || 3001);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const THECATAPI_API_KEY = process.env.THECATAPI_API_KEY || "";
const GEMINI_MODEL = "gemini-3.6-flash";

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});
app.use(express.static("public", {
    maxAge: 0,
    setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }
}));

const CUSTOM_IMAGES_DIR = path.join(__dirname, "public", "images", "products");
const CUSTOM_IMAGE_META_PATH = path.join(CUSTOM_IMAGES_DIR, "custom-images.json");
const DATA_DIR = path.join(__dirname, "data");
const EDITED_PRODUCTS_PATH = path.join(DATA_DIR, "edited-products.json");
const AUTH_USERS_PATH = path.join(DATA_DIR, "users.json");
const AUTH_SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const CARE_SCHEDULES_PATH = path.join(DATA_DIR, "care-schedules.json");
const CAT_PROFILES_PATH = path.join(DATA_DIR, "cat-profiles.json");
const customImageMap = {};
const authAttempts = new Map();
const aiAnalyzeAttempts = new Map();
const AUTH_SESSION_COOKIE = "meow_session";
const AUTH_STATE_COOKIE_PREFIX = "meow_oauth_state_";
const AUTH_SESSION_SHORT_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_LONG_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_PROVIDERS = {
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirectUri: process.env.GOOGLE_REDIRECT_URI || `${String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "")}/auth/google/callback`,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        scope: "openid email profile"
    },
    line: {
        clientId: process.env.LINE_CHANNEL_ID || "",
        clientSecret: process.env.LINE_CHANNEL_SECRET || "",
        redirectUri: process.env.LINE_REDIRECT_URI || `${String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "")}/auth/line/callback`,
        authorizationUrl: "https://access.line.me/oauth2/v2.1/authorize",
        tokenUrl: "https://api.line.me/oauth2/v2.1/token",
        userInfoUrl: "https://api.line.me/oauth2/v2.1/userinfo",
        scope: "openid profile email"
    },
    facebook: {
        clientId: process.env.FACEBOOK_APP_ID || "",
        clientSecret: process.env.FACEBOOK_APP_SECRET || "",
        redirectUri: process.env.FACEBOOK_REDIRECT_URI || `${String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "")}/auth/facebook/callback`,
        authorizationUrl: `https://www.facebook.com/${/^[vV]\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_API_VERSION || "") ? process.env.FACEBOOK_GRAPH_API_VERSION : "v23.0"}/dialog/oauth`,
        tokenUrl: `https://graph.facebook.com/${/^[vV]\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_API_VERSION || "") ? process.env.FACEBOOK_GRAPH_API_VERSION : "v23.0"}/oauth/access_token`,
        userInfoUrl: `https://graph.facebook.com/${/^[vV]\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_API_VERSION || "") ? process.env.FACEBOOK_GRAPH_API_VERSION : "v23.0"}/me`,
        scope: "public_profile email"
    }
};

function readAuthJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid authentication data in ${path.basename(filePath)}`);
    }
    return parsed;
}

function writeAuthJson(filePath, value) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
}

function readCareSchedules() {
    if (!fs.existsSync(CARE_SCHEDULES_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(CARE_SCHEDULES_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid care schedule data");
    }
    return parsed;
}

function readCatProfiles() {
    if (!fs.existsSync(CAT_PROFILES_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(CAT_PROFILES_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid cat profile data");
    }
    return parsed;
}

function isValidCareDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateCareSchedule(value) {
    const allowedTypes = new Set(["feeding", "vaccine", "vet", "other"]);
    const allowedChecklistItems = new Set(["food", "water", "health", "play", "brush"]);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !Array.isArray(value.reminders) || value.reminders.length > 1000
        || !value.checklists || typeof value.checklists !== "object" || Array.isArray(value.checklists)) {
        return null;
    }

    const reminderIds = new Set();
    const reminders = [];
    for (const reminder of value.reminders) {
        if (!reminder || typeof reminder !== "object" || Array.isArray(reminder)
            || typeof reminder.id !== "string" || reminder.id.length < 1 || reminder.id.length > 100
            || reminderIds.has(reminder.id) || !allowedTypes.has(reminder.type)
            || typeof reminder.title !== "string" || !reminder.title.trim() || reminder.title.length > 80
            || !isValidCareDate(reminder.date) || typeof reminder.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminder.time)
            || typeof reminder.note !== "string" || reminder.note.length > 200
            || typeof reminder.isComplete !== "boolean") {
            return null;
        }
        reminderIds.add(reminder.id);
        reminders.push({
            id: reminder.id,
            type: reminder.type,
            title: reminder.title.trim(),
            date: reminder.date,
            time: reminder.time,
            note: reminder.note.trim(),
            isComplete: reminder.isComplete
        });
    }

    const checklists = {};
    const checklistDates = Object.entries(value.checklists);
    if (checklistDates.length > 3660) return null;
    for (const [date, items] of checklistDates) {
        if (!isValidCareDate(date) || !Array.isArray(items) || items.length > allowedChecklistItems.size
            || items.some((item) => typeof item !== "string" || !allowedChecklistItems.has(item))) {
            return null;
        }
        checklists[date] = [...new Set(items)];
    }
    return { reminders, checklists };
}

function validateCatProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.name !== "string" || value.name.trim().length > 50
        || typeof value.age !== "string" || value.age.length > 40
        || typeof value.breed !== "string" || value.breed.length > 60
        || !["female", "male", "unspecified"].includes(value.sex)
        || (value.photo !== null && (typeof value.photo !== "string"
            || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.photo)
            || Buffer.byteLength(value.photo, "utf8") > 1024 * 1024))) {
        return null;
    }

    return {
        name: value.name.trim(),
        age: value.age.trim(),
        breed: value.breed.trim(),
        sex: value.sex,
        photo: value.photo
    };
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseCookies(req) {
    const cookies = {};
    String(req.headers.cookie || "").split(";").forEach((part) => {
        const separator = part.indexOf("=");
        if (separator < 1) return;
        const name = part.slice(0, separator).trim();
        try {
            cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
        } catch (error) {
            console.warn("Ignoring malformed cookie value.");
        }
    });
    return cookies;
}

function serializeCookie(name, value, maxAgeSeconds) {
    const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
    if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${maxAgeSeconds}`);
    if (process.env.NODE_ENV === "production") parts.push("Secure");
    return parts.join("; ");
}

function clearCookie(res, name) {
    res.append("Set-Cookie", serializeCookie(name, "", 0));
}

function rejectCrossOriginRequest(req, res) {
    const origin = req.get("origin");
    if (!origin) return false;

    try {
        if (new URL(origin).host === req.get("host")) return false;
    } catch (error) {
        console.warn("Rejected authentication request with an invalid Origin header.");
    }

    res.status(403).json({ error: "คำขอไม่ปลอดภัย กรุณาโหลดหน้าเว็บใหม่" });
    return true;
}

function publicAuthUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email || null
    };
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [algorithm, saltHex, hashHex] = String(storedHash || "").split("$");
    if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) {
        return false;
    }

    const derivedKey = await scrypt(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(derivedKey, Buffer.from(hashHex, "hex"));
}

function createAuthSession(res, user, rememberMe) {
    const sessions = readAuthJson(AUTH_SESSIONS_PATH, []);
    const now = Date.now();
    const lifetime = rememberMe ? AUTH_SESSION_LONG_MS : AUTH_SESSION_SHORT_MS;
    const expiresAt = now + lifetime;
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const activeSessions = sessions.filter((session) => Number(session.expiresAt) > now);
    activeSessions.push({ tokenHash, userId: user.id, expiresAt });
    writeAuthJson(AUTH_SESSIONS_PATH, activeSessions);
    res.append("Set-Cookie", serializeCookie(AUTH_SESSION_COOKIE, token, Math.floor(lifetime / 1000)));
}

function getAuthenticatedUser(req, res) {
    const token = parseCookies(req)[AUTH_SESSION_COOKIE];
    if (!token) return null;

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const sessions = readAuthJson(AUTH_SESSIONS_PATH, []);
    const session = sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;

    if (Number(session.expiresAt) <= Date.now()) {
        writeAuthJson(AUTH_SESSIONS_PATH, sessions.filter((item) => item !== session));
        clearCookie(res, AUTH_SESSION_COOKIE);
        return null;
    }

    const users = readAuthJson(AUTH_USERS_PATH, []);
    const user = users.find((item) => item.id === session.userId);
    if (!user) {
        writeAuthJson(AUTH_SESSIONS_PATH, sessions.filter((item) => item !== session));
        clearCookie(res, AUTH_SESSION_COOKIE);
        return null;
    }

    return user;
}

function requireAuthenticatedApi(req, res, next) {
    try {
        const user = getAuthenticatedUser(req, res);
        if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบก่อนเข้าถึงข้อมูล" });
        req.authenticatedUser = user;
        return next();
    } catch (error) {
        console.error("Unable to verify the account for a protected data request:", error.message);
        return res.status(500).json({ error: "ตรวจสอบบัญชีก่อนเข้าถึงข้อมูลไม่สำเร็จ" });
    }
}

function checkAuthRateLimit(req, res) {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const previous = authAttempts.get(key);
    if (!previous || now - previous.startedAt >= 15 * 60 * 1000) {
        authAttempts.set(key, { startedAt: now, count: 1 });
        return false;
    }

    previous.count += 1;
    if (previous.count <= 10) return false;

    res.status(429).json({ error: "มีการลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" });
    return true;
}

function clearAuthRateLimit(req) {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    authAttempts.delete(key);
}

function isOAuthProviderConfigured(provider) {
    const config = OAUTH_PROVIDERS[provider];
    return Boolean(config && config.clientId && config.clientSecret && config.redirectUri);
}

function redirectAuthError(res, message) {
    res.redirect(`/?auth_error=${encodeURIComponent(message)}`);
}

function getOAuthProviderConfig(provider) {
    if (provider !== "google" && provider !== "line" && provider !== "facebook") return null;
    return OAUTH_PROVIDERS[provider];
}

async function exchangeOAuthIdentity(provider, code) {
    const config = getOAuthProviderConfig(provider);
    const tokenParameters = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret
        });
    const tokenUrl = new URL(config.tokenUrl);
    let tokenResponse;
    if (provider === "facebook") {
        tokenParameters.delete("grant_type");
        tokenUrl.search = tokenParameters.toString();
        tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
    } else {
        tokenResponse = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenParameters,
            signal: AbortSignal.timeout(10000)
        });
    }
    if (!tokenResponse.ok) {
        throw new Error(`${provider} token exchange failed with HTTP ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
        throw new Error(`${provider} did not return an access token`);
    }

    const profileUrl = new URL(config.userInfoUrl);
    const profileOptions = { signal: AbortSignal.timeout(10000) };
    if (provider === "facebook") {
        profileUrl.searchParams.set("fields", "id,name,email");
        profileUrl.searchParams.set("access_token", tokenData.access_token);
    } else {
        profileOptions.headers = { Authorization: `Bearer ${tokenData.access_token}` };
    }
    const profileResponse = await fetch(profileUrl, profileOptions);
    if (!profileResponse.ok) {
        throw new Error(`${provider} profile request failed with HTTP ${profileResponse.status}`);
    }

    const profile = await profileResponse.json();
    const subject = provider === "facebook" ? profile.id : profile.sub;
    if (typeof subject !== "string" || !subject) {
        throw new Error(`${provider} did not return a user identifier`);
    }

    return { ...profile, sub: subject };
}

function findOrCreateOAuthUser(provider, profile) {
    const users = readAuthJson(AUTH_USERS_PATH, []);
    let user = users.find((item) => item.providers && item.providers[provider] && item.providers[provider].subject === profile.sub);
    if (user) {
        if (typeof profile.name === "string" && profile.name.trim()) {
            user.name = profile.name.trim().slice(0, 60);
        }
        if (typeof profile.email === "string" && isValidEmail(profile.email)) {
            user.email = normalizeEmail(profile.email);
        }
    } else {
        user = {
            id: crypto.randomUUID(),
            name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 60) : "สมาชิก Meow Museum",
            email: typeof profile.email === "string" && isValidEmail(profile.email) ? normalizeEmail(profile.email) : null,
            passwordHash: null,
            providers: { [provider]: { subject: profile.sub } },
            createdAt: new Date().toISOString()
        };
        users.push(user);
    }

    writeAuthJson(AUTH_USERS_PATH, users);
    return user;
}

const BRAND_PATTERNS = [
    ["ซีพี", ["ซีพี", "cp", "c.p.", "cp all"]],
    ["เอส-เพียว", ["เอส-เพียว", "เอสเพียว", "s-pew", "spew", "s pew"]],
    ["เบทาโกร", ["เบทาโกร", "betagro", "betagro food"]],
    ["เนสท์เล่", ["เนสท์เล่", "nestle", "nestlé"]],
    ["มาม่า", ["มาม่า", "mama", "mama noodles"]],
    ["ไวไว", ["ไวไว", "wai wai", "waiwai"]],
    ["ยำยำ", ["ยำยำ", "yum yum", "yumyum"]],
    ["ดัชมิลล์", ["ดัชมิลล์", "duch mill", "duchmill"]],
    ["ไทย-เดนมาร์ค", ["ไทย-เดนมาร์ค", "thai denmark", "thaidenmark", "thai-denmark"]],
    ["โฟร์โมสต์", ["โฟร์โมสต์", "four most", "fourmost"]],
    ["โอวัลติน", ["โอวัลติน", "ovaltine", "ovaltine"]],
    ["ไมโล", ["ไมโล", "milo"]],
    ["โออิชิ", ["โออิชิ", "oishi", "o'ishi"]],
    ["ส.ขอนแก่น", ["ส.ขอนแก่น", "สขอนแก่น", "s. khonkaen", "s khonkaen", "s.khonkaen"]],
    ["เด็กสมบูรณ์", ["เด็กสมบูรณ์", "ด็กสมบูรณ์", "เด็กสมบูรณ์", "ด็อกสมบูรณ์", "dok somboon"]],
    ["ภูเขาทอง", ["ภูเขาทอง", "phu kaothong", "ภูเขาทอง"]],
    ["ทิปโก้", ["ทิปโก้", "tipco", "tip go"]],
    ["ดอยคำ", ["ดอยคำ", "doykum", "doy kwam"]],
    ["อิชิตัน", ["อิชิตัน", "ichitan"]],
    ["คาราบาว", ["คาราบาว", "karabao"]],
    ["ลิปตัน", ["ลิปตัน", "lipton"]],
    ["เลย์", ["เลย์", "lay"]],
    ["โก๋แก่", ["โก๋แก่", "ko kae", "ko-kae"]],
    ["ฟาร์มเฮ้าส์", ["ฟาร์มเฮ้าส์", "farm house", "farmhouse"]],
    ["การ์เด้น", ["การ์เด้น", "garden"]],
    ["ยูโร่", ["ยูโร่", "euro"]],
    ["ทิวลี่", ["ทิวลี่", "tiew lee", "tielee"]],
    ["ป๊อกกี้", ["ป๊อกกี้", "pocky"]],
    ["โคคา-โคล่า", ["โคคา-โคล่า", "coca cola", "coca-cola"]],
    ["เป๊ปซี่", ["เป๊ปซี่", "pepsi", "pepsii"]]
];

let foods = [];
const REMOVED_PRODUCT_CODES = new Set([
    "8854698012041"
]);
const REMOVED_PRODUCT_PATTERNS = [
    /\boishi\b/i,
    /โออิชิ/i
];
const MAX_BRAND_PAGES = 1;
const PAGE_SIZE = 60;
const API_DELAY_MS = 600;

const EXTRA_CATEGORY_PRODUCTS = [
    {
        id: "chip-lay-classic",
        name: "Lay Potato Chips Classic",
        brand: "Lay",
        flavor: "Classic Salted",
        barcode: "chip-lay-classic",
        nutriScore: "B",
        energy: 530,
        sugar: 1,
        fat: 31,
        protein: 6,
        ingredients: "Potato, vegetable oil, salt",
        image: "",
        apiImage: "",
        customImage: "",
        category: "chips"
    },
    {
        id: "chip-pringles-original",
        name: "Pringles Potato Chips Original",
        brand: "Pringles",
        flavor: "Original",
        barcode: "chip-pringles-original",
        nutriScore: "B",
        energy: 535,
        sugar: 2,
        fat: 33,
        protein: 5,
        ingredients: "Potato starch, vegetable oil, seasoning",
        image: "",
        apiImage: "",
        customImage: "",
        category: "chips"
    },
    {
        id: "chip-oishi-crispy",
        name: "Oishi Crispy Potato Chips",
        brand: "Oishi",
        flavor: "Sea Salt",
        barcode: "chip-oishi-crispy",
        nutriScore: "B",
        energy: 500,
        sugar: 2,
        fat: 30,
        protein: 5,
        ingredients: "Potato, palm oil, seasoning, salt",
        image: "",
        apiImage: "",
        customImage: "",
        category: "chips"
    },
    {
        id: "bread-gardenia-classic",
        name: "Gardenia Classic White Bread",
        brand: "Gardenia",
        flavor: "Classic White",
        barcode: "bread-gardenia-classic",
        nutriScore: "B",
        energy: 250,
        sugar: 4,
        fat: 2,
        protein: 9,
        ingredients: "Wheat flour, water, yeast, sugar, salt",
        image: "",
        apiImage: "",
        customImage: "",
        category: "bread"
    },
    {
        id: "bread-toast-wheat",
        name: "Wheat Toast Bread",
        brand: "Bake House",
        flavor: "Whole Wheat",
        barcode: "bread-toast-wheat",
        nutriScore: "A",
        energy: 230,
        sugar: 3,
        fat: 1,
        protein: 8,
        ingredients: "Whole wheat flour, water, yeast, sesame, salt",
        image: "",
        apiImage: "",
        customImage: "",
        category: "bread"
    },
    {
        id: "bread-wafer-cracker",
        name: "Crispy Wheat Crackers Bread",
        brand: "Baker's Choice",
        flavor: "Original",
        barcode: "bread-wafer-cracker",
        nutriScore: "B",
        energy: 420,
        sugar: 5,
        fat: 16,
        protein: 9,
        ingredients: "Wheat flour, vegetable oil, yeast, salt",
        image: "",
        apiImage: "",
        customImage: "",
        category: "bread"
    },
    {
        id: "3017620422003",
        name: "Nutella Hazelnut Spread",
        brand: "Ferrero, Nutella",
        flavor: "Hazelnut cocoa spread",
        barcode: "3017620422003",
        nutriScore: "E",
        energy: 539,
        sugar: 56.3,
        fat: 30.9,
        protein: 6.3,
        ingredients: "Sugar, palm oil, hazelnuts, skimmed milk powder, cocoa, soy lecithins, vanillin",
        image: "https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.400.jpg",
        apiImage: "https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.400.jpg",
        customImage: "",
        category: "chips"
    },
    {
        id: "5000159484695",
        name: "Twix glacé",
        brand: "Twix",
        flavor: "Caramel and chocolate ice cream",
        barcode: "5000159484695",
        nutriScore: "E",
        energy: 280.74,
        sugar: 25.52,
        fat: 14.62,
        protein: 2.78,
        ingredients: "Sugar, glucose syrup, skimmed milk, cream, cocoa butter, coconut fat, wheat flour, palm fat, soy lecithin, salt",
        image: "https://images.openfoodfacts.org/images/products/500/015/948/4695/front_fr.85.400.jpg",
        apiImage: "https://images.openfoodfacts.org/images/products/500/015/948/4695/front_fr.85.400.jpg",
        customImage: "",
        category: "chips"
    },
    {
        id: "7622210449283",
        name: "LU Prince Wholegrain Chocolate Biscuits",
        brand: "LU, Prince",
        flavor: "Wholegrain chocolate",
        barcode: "7622210449283",
        nutriScore: "E",
        energy: 467,
        sugar: 32,
        fat: 17,
        protein: 6.3,
        ingredients: "Wheat flour, whole wheat flour, sugar, vegetable oils, cocoa, glucose syrup, salt",
        image: "https://images.openfoodfacts.org/images/products/762/221/044/9283/front_en.605.400.jpg",
        apiImage: "https://images.openfoodfacts.org/images/products/762/221/044/9283/front_en.605.400.jpg",
        customImage: "",
        category: "chips"
    }
];

const DEMO_PRODUCT_GROUPS = [
    {
        category: "milk",
        names: ["นมโคพาสเจอร์ไรส์รสจืด", "นมโคยูเอชทีรสช็อกโกแลต", "นมถั่วเหลืองสูตรดั้งเดิม", "นมถั่วเหลืองไม่เติมน้ำตาล", "นมอัลมอนด์สูตรดั้งเดิม", "นมข้าวโอ๊ตสูตรต้นตำรับ", "โยเกิร์ตรสธรรมชาติ", "โยเกิร์ตพร้อมดื่มรสสตรอว์เบอร์รี", "นมเปรี้ยวพร้อมดื่ม", "ชีสเชดดาร์แบบแผ่น"],
        sizes: ["250 มล.", "1 ลิตร"],
        nutrition: { energy: 110, sugar: 8, fat: 4, protein: 4 }
    },
    {
        category: "chips",
        names: ["มันฝรั่งทอดกรอบรสดั้งเดิม", "มันฝรั่งทอดกรอบรสสาหร่าย", "ข้าวโพดอบกรอบรสชีส", "ขนมข้าวอบกรอบรสซาวครีม", "ถั่วลิสงอบเกลือ", "อัลมอนด์อบ", "เม็ดมะม่วงหิมพานต์อบ", "แครกเกอร์รสเกลือ", "ป๊อปคอร์นรสคาราเมล", "บิสกิตช็อกโกแลต"],
        sizes: ["40 ก.", "120 ก."],
        nutrition: { energy: 480, sugar: 8, fat: 24, protein: 7 }
    },
    {
        category: "bread",
        names: ["ขนมปังโฮลวีต", "ขนมปังแผ่นขาว", "ขนมปังธัญพืช", "ขนมปังไรย์", "ขนมปังไส้ถั่วแดง", "ขนมปังไส้ครีม", "ครัวซองต์เนย", "ขนมปังข้าวโอ๊ต", "มัฟฟินกล้วยหอม", "แซนด์วิชทูน่า"],
        sizes: ["2 ชิ้น", "6 ชิ้น"],
        nutrition: { energy: 270, sugar: 9, fat: 7, protein: 8 }
    },
    {
        category: "rice",
        names: ["ข้าวหอมมะลิ", "ข้าวกล้องหอมมะลิ", "ข้าวไรซ์เบอร์รี", "ข้าวโอ๊ตเต็มเมล็ด", "ซีเรียลข้าวโพด", "กราโนล่าผสมผลไม้", "ธัญพืชอบกรอบ", "ข้าวแต๋นรสหวาน", "ข้าวกล้องงอก", "คีนัวผสมธัญพืช"],
        sizes: ["250 ก.", "1 กก."],
        nutrition: { energy: 360, sugar: 5, fat: 4, protein: 9 }
    },
    {
        category: "juice",
        names: ["น้ำส้มผสมเนื้อส้ม", "น้ำแอปเปิล", "น้ำมะเขือเทศ", "น้ำองุ่นแดง", "ชามะนาวพร้อมดื่ม", "ชาเขียวไม่เติมน้ำตาล", "กาแฟนมพร้อมดื่ม", "น้ำมะพร้าว", "เครื่องดื่มมะม่วง", "น้ำลิ้นจี่"],
        sizes: ["250 มล.", "1 ลิตร"],
        nutrition: { energy: 65, sugar: 11, fat: 1, protein: 1 }
    }
];

function createDemoProductImage(category, index) {
    const palettes = [
        { background: "#edf8f0", accent: "#168a5b", light: "#bfe7ce" },
        { background: "#fff4e8", accent: "#df7a32", light: "#f6d2a8" },
        { background: "#eef5fb", accent: "#3e82ad", light: "#c2dced" },
        { background: "#fff0ee", accent: "#c95c59", light: "#f0c2ba" },
        { background: "#f4f3e8", accent: "#7d8c3d", light: "#d9dfaa" }
    ];
    const palette = palettes[index % palettes.length];
    const label = { milk: "DAIRY", chips: "SNACK", bread: "BAKERY", rice: "GRAINS", juice: "DRINK" }[category] || "FOOD";
    const packageShape = {
        milk: `<path d="M91 48h43l30 28v118H91z" fill="#fff" stroke="${palette.accent}" stroke-width="5"/><path d="M91 48h43l-8 28H91z" fill="${palette.light}"/><path d="M134 48v28h30" fill="none" stroke="${palette.accent}" stroke-width="4"/>`,
        chips: `<path d="M88 48q32 12 64 0l11 142q-43 18-86 0z" fill="#fff" stroke="${palette.accent}" stroke-width="5"/><path d="M91 65h58v28H91z" fill="${palette.light}"/>`,
        bread: `<rect x="80" y="60" width="80" height="136" rx="25" fill="#fff" stroke="${palette.accent}" stroke-width="5"/><path d="M80 100q40-30 80 0v21H80z" fill="${palette.light}"/>`,
        rice: `<path d="M95 48q25 18 50 0l18 140q-43 22-86 0z" fill="#fff" stroke="${palette.accent}" stroke-width="5"/><path d="M95 52h50v24H95z" fill="${palette.light}"/>`,
        juice: `<path d="M108 43h24v23l20 18v108q-32 12-64 0V84l20-18z" fill="#fff" stroke="${palette.accent}" stroke-width="5"/><path d="M108 43h24v23h-24z" fill="${palette.light}"/>`
    }[category];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" rx="24" fill="${palette.background}"/><circle cx="188" cy="48" r="18" fill="${palette.light}"/><circle cx="52" cy="184" r="12" fill="${palette.light}"/>${packageShape}<rect x="91" y="108" width="72" height="42" rx="8" fill="${palette.light}"/><text x="127" y="125" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="${palette.accent}">DEMO</text><text x="127" y="140" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" font-weight="700" fill="${palette.accent}">${label}</text><path d="M105 166h44" stroke="${palette.accent}" stroke-width="3" stroke-linecap="round"/><text x="120" y="222" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="${palette.accent}">SAMPLE PRODUCT</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function createDemoProductCatalog() {
    return DEMO_PRODUCT_GROUPS.flatMap((group) => group.names.flatMap((name, itemIndex) => group.sizes.map((size, sizeIndex) => {
        const index = itemIndex * group.sizes.length + sizeIndex;
        const variation = index % 5;
        const id = `demo-${group.category}-${String(index + 1).padStart(2, "0")}`;
        return {
            id,
            name: `${name} ${size}`,
            brand: "สินค้าเดโม",
            flavor: "สูตรตัวอย่าง",
            barcode: id,
            nutriScore: "-",
            energy: group.nutrition.energy + variation * 4,
            sugar: group.nutrition.sugar + variation,
            fat: group.nutrition.fat + variation,
            protein: group.nutrition.protein + variation,
            ingredients: "ข้อมูลโภชนาการตัวอย่างเพื่อการสาธิตเท่านั้น",
            image: createDemoProductImage(group.category, index),
            apiImage: "",
            customImage: "",
            category: group.category,
            isSample: true
        };
    })));
}

function createBuiltInFoodCatalog() {
    const builtInProducts = EXTRA_CATEGORY_PRODUCTS
        .filter((product) => !REMOVED_PRODUCT_CODES.has(String(product.barcode || product.id || "").trim()) && !isBlockedProduct(product))
        .map((product) => ({ ...product, category: product.category || inferFoodCategory(product) }));
    return [...builtInProducts, ...createDemoProductCatalog()];
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCustomImageStorage() {
    fs.mkdirSync(CUSTOM_IMAGES_DIR, { recursive: true });
}

function loadCustomImageMap() {
    try {
        ensureCustomImageStorage();
        if (!fs.existsSync(CUSTOM_IMAGE_META_PATH)) {
            fs.writeFileSync(CUSTOM_IMAGE_META_PATH, JSON.stringify({}, null, 2), "utf8");
        }

        const raw = fs.readFileSync(CUSTOM_IMAGE_META_PATH, "utf8");
        const parsed = JSON.parse(raw || "{}");

        Object.keys(parsed).forEach((barcode) => {
            const imagePath = parsed[barcode];
            customImageMap[barcode] = typeof imagePath === "string" && imagePath.trim() ? imagePath : undefined;
        });
    } catch (error) {
        console.warn("ไม่สามารถโหลด custom image metadata ได้:", error.message);
    }
}

function saveCustomImageMap() {
    try {
        ensureCustomImageStorage();
        const cleaned = {};
        Object.entries(customImageMap).forEach(([barcode, imagePath]) => {
            if (barcode && imagePath) {
                cleaned[barcode] = imagePath;
            }
        });
        fs.writeFileSync(CUSTOM_IMAGE_META_PATH, JSON.stringify(cleaned, null, 2), "utf8");
    } catch (error) {
        console.warn("ไม่สามารถบันทึก custom image metadata ได้:", error.message);
    }
}

function ensureEditedProductsStorage() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(EDITED_PRODUCTS_PATH)) {
            fs.writeFileSync(EDITED_PRODUCTS_PATH, JSON.stringify({}, null, 2), "utf8");
        }
    } catch (error) {
        console.warn("ไม่สามารถเตรียมโครงสร้างข้อมูลที่แก้ไขได้:", error.message);
    }
}

function loadEditedProductsMap() {
    try {
        ensureEditedProductsStorage();
        const raw = fs.readFileSync(EDITED_PRODUCTS_PATH, "utf8");
        const parsed = JSON.parse(raw || "{}");
        editedProductsMap = parsed && typeof parsed === "object" ? parsed : {};
        return editedProductsMap;
    } catch (error) {
        console.warn("ไม่สามารถโหลดข้อมูลที่แก้ไขได้:", error.message);
        editedProductsMap = {};
        return {};
    }
}

function saveEditedProductsMap(map) {
    try {
        ensureEditedProductsStorage();
        const normalized = map && typeof map === "object" ? map : {};
        editedProductsMap = normalized;
        fs.writeFileSync(EDITED_PRODUCTS_PATH, JSON.stringify(normalized, null, 2), "utf8");
        return normalized;
    } catch (error) {
        console.warn("ไม่สามารถบันทึกข้อมูลที่แก้ไขได้:", error.message);
        return editedProductsMap;
    }
}

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]/gu, "")
        .trim();
}

function isBlockedProduct(product) {
    const barcode = String(product?.barcode || product?.id || "").trim();
    if (REMOVED_PRODUCT_CODES.has(barcode)) {
        return true;
    }

    const text = `${product?.name || ""} ${product?.brand || ""} ${product?.flavor || ""}`;
    return REMOVED_PRODUCT_PATTERNS.some((pattern) => pattern.test(text));
}

function brandMatchesCandidate(candidateBrand, targetBrand) {
    const cleanCandidate = normalizeText(candidateBrand);
    const cleanTarget = normalizeText(targetBrand);

    if (!cleanCandidate || !cleanTarget) {
        return false;
    }

    const aliases = BRAND_PATTERNS.find(([brand]) => normalizeText(brand) === cleanTarget || normalizeText(brand).includes(cleanTarget)) || [targetBrand, [targetBrand]];
    const possibleNames = aliases[1] || [targetBrand];

    return possibleNames.some(alias => {
        const cleanAlias = normalizeText(alias);
        if (!cleanAlias) {
            return false;
        }

        return cleanCandidate.includes(cleanAlias) || cleanAlias.includes(cleanCandidate);
    }) || cleanCandidate.includes(cleanTarget) || cleanTarget.includes(cleanCandidate);
}

function isSupportedBrand(brandText) {
    const candidates = String(brandText || "")
        .split(/[;,]/)
        .map(item => item.trim())
        .filter(Boolean);

    return candidates.some(candidate => BRAND_PATTERNS.some(([brandName, aliases]) => {
        const aliasList = [brandName, ...(aliases || [])];
        return aliasList.some(alias => brandMatchesCandidate(candidate, alias));
    }));
}

function extractProductNumber(product, keys) {
    const nutriments = product?.nutriments || {};

    for (const key of keys) {
        const value = nutriments[key];
        if (value !== undefined && value !== null && value !== "") {
            const numeric = Number(value);
            if (!Number.isNaN(numeric)) {
                return numeric;
            }
        }
    }

    return undefined;
}

function getBestImage(product) {
    const candidates = [
        product.image_front_url,
        product.image_front_small_url,
        product.image_url,
        product.image_front_thumb_url,
        product.selected_images?.front?.display?.fr,
        product.selected_images?.front?.display?.en,
        product.selected_images?.front?.display?.th,
        product.selected_images?.front?.small?.fr,
        product.selected_images?.front?.small?.en,
        product.selected_images?.front?.small?.th
    ];

    return candidates.find(item => typeof item === "string" && item.trim()) || "";
}

function getProductFlavor(product) {
    const value = product.flavor || product.flavour || product.flavor_text || product.product_name_en || product.product_name_th || product.generic_name;
    return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function getCustomImageForProduct(product) {
    const barcode = String(product?.code || product?._id || "").trim();
    if (!barcode || !customImageMap[barcode]) {
        return "";
    }
    return customImageMap[barcode];
}

function normalizeFoodRecord(product, matchedBrand) {
    const apiImage = getBestImage(product);
    const customImage = getCustomImageForProduct(product);
    const image = customImage || apiImage;
    const name = product.product_name || product.product_name_en || product.product_name_th || product.generic_name || product.product_name_fr || "-";
    const brand = product.brands || matchedBrand || "-";
    const barcode = String(product.code || product._id || "").trim();
    const energyKcal = extractProductNumber(product, ["energy-kcal_100g"]);
    const energyKj = extractProductNumber(product, ["energy_100g"]);

    return {
        id: String(product.code || product._id || `${name}-${brand}-${Math.random().toString(16).slice(2)}`),
        name,
        brand,
        flavor: getProductFlavor(product),
        barcode: barcode || "-",
        nutriScore: product.nutriscore_grade || product.nutrition_grades || "-",
        energy: energyKcal ?? (energyKj === undefined ? undefined : energyKj / 4.184),
        sugar: extractProductNumber(product, ["sugars_100g", "sugar_100g"]),
        fat: extractProductNumber(product, ["fat_100g", "fat_total_100g"]),
        protein: extractProductNumber(product, ["proteins_100g", "proteins"]),
        ingredients: product.ingredients_text || product.ingredients_text_th || product.ingredients_text_en || "-",
        image,
        apiImage,
        customImage: customImage || ""
    };
}

async function fetchOpenFoodFactsByBrand(brand, page = 1, retries = 3) {
    const url = new URL("https://world.openfoodfacts.org/api/v2/search");
    url.search = new URLSearchParams({
        search_terms: brand,
        sort_by: "unique_scans_n",
        page: String(page),
        page_size: String(PAGE_SIZE),
        fields: "product_name,product_name_en,product_name_th,generic_name,brands,code,image_front_url,image_front_small_url,image_url,image_front_thumb_url,selected_images,nutriments,ingredients_text,ingredients_text_th,ingredients_text_en,nutriscore_grade,nutrition_grades,flavor,flavour,quantity"
    }).toString();

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const response = await fetch(url.toString(), {
            headers: {
                "User-Agent": "FoodCheck/1.0 (student-project)",
                "Accept": "application/json",
                "Accept-Language": "th,en-US;q=0.9,en;q=0.8"
            }
        });

        if (response.ok) {
            const data = await response.json();
            const products = Array.isArray(data.products) ? data.products : [];
            return {
                products,
                page: Number(data.page || page),
                pageCount: Number(data.page_count || 1)
            };
        }

        if (response.status === 429 || response.status === 500 || response.status === 503) {
            if (attempt < retries) {
                await wait(Math.min(API_DELAY_MS * attempt * 2, 3000));
                continue;
            }
        }

        throw new Error(`API ตอบ status ${response.status} สำหรับแบรนด์ ${brand}`);
    }

    throw new Error(`API ล้มเหลวสำหรับแบรนด์ ${brand}`);
}

async function loadFoods() {
    foods = createBuiltInFoodCatalog();
    const seen = new Map();

    const activeBrands = [
        "เนสท์เล่",
        "โออิชิ",
        "ดอยคำ",
        "เป๊ปซี่",
        "ฟาร์มเฮ้าส์",
        "ทิปโก้",
        "ไทย-เดนมาร์ค",
        "มาม่า",
        "โก๋แก่",
        "อิชิตัน"
    ];

    for (const brand of activeBrands) {
        let page = 1;

        while (page <= MAX_BRAND_PAGES) {
            try {
                await wait(API_DELAY_MS);
                const result = await fetchOpenFoodFactsByBrand(brand, page, 2);
                const products = result.products || [];

                if (!products.length) {
                    break;
                }

                for (const product of products) {
                    const rawBrand = String(product.brands || "");

                    if (!isSupportedBrand(rawBrand)) {
                        continue;
                    }

                    const normalized = normalizeFoodRecord(product, rawBrand);
                    const dedupeKey = normalized.barcode && normalized.barcode !== "-" ? `code:${normalized.barcode}` : `fallback:${normalized.name}|${normalized.brand}|${normalized.ingredients}`;

                    if (
                        !normalized.name ||
                        normalized.name === "-" ||
                        !normalized.brand ||
                        seen.has(dedupeKey) ||
                        isBlockedProduct(normalized)
                    ) {
                        continue;
                    }

                    seen.set(dedupeKey, normalized);
                }

                if (result.page >= result.pageCount) {
                    break;
                }

                page += 1;
            } catch (error) {
                console.warn(`skip brand ${brand} page ${page}:`, error.message);
                break;
            }
        }
    }

    foods = Array.from(seen.values()).filter((item) => !isBlockedProduct(item));

    const extraFoods = EXTRA_CATEGORY_PRODUCTS.filter((product) => {
        const productKey = String(product.barcode || product.id || "").trim();
        if (REMOVED_PRODUCT_CODES.has(productKey) || isBlockedProduct(product)) {
            return false;
        }

        const existing = foods.some((item) => {
            const itemKey = String(item.barcode || item.id || "");
            return itemKey && productKey && itemKey === productKey;
        });
        return !existing;
    }).map((product) => ({
        ...product,
        category: product.category || inferFoodCategory(product)
    }));

    if (extraFoods.length) {
        foods.push(...extraFoods);
    }

    foods.push(...createDemoProductCatalog());

    if (!foods.length) {
        console.warn("Open Food Facts ไม่มีข้อมูลสำหรับแบรนด์ที่เลือก");
        foods = [];
        return;
    }

    console.log(`โหลดข้อมูลจาก Open Food Facts สำเร็จ: ${foods.length} รายการ`);
}

function selectionSort(arr) {
    const a = [...arr];
    for (let i = 0; i < a.length - 1; i++) {
        let minIndex = i;
        for (let j = i + 1; j < a.length; j++) {
            const current = Number(a[j].sugar || 0);
            const minimum = Number(a[minIndex].sugar || 0);
            if (current < minimum) {
                minIndex = j;
            }
        }
        [a[i], a[minIndex]] = [a[minIndex], a[i]];
    }
    return a;
}

function insertionSort(arr) {
    const a = [...arr];
    for (let i = 1; i < a.length; i++) {
        const key = a[i];
        let j = i - 1;
        while (j >= 0 && Number(a[j].sugar || 0) > Number(key.sugar || 0)) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = key;
    }
    return a;
}

function bubbleSort(arr) {
    const a = [...arr];
    for (let i = 0; i < a.length - 1; i++) {
        for (let j = 0; j < a.length - 1 - i; j++) {
            if (Number(a[j].sugar || 0) > Number(a[j + 1].sugar || 0)) {
                [a[j], a[j + 1]] = [a[j + 1], a[j]];
            }
        }
    }
    return a;
}

function sortByMetric(arr, metric) {
    const key = ["sugar", "protein", "fat"].includes(metric) ? metric : "sugar";
    const a = [...arr];

    a.sort((left, right) => {
        const leftValue = Number(left?.[key] ?? 0);
        const rightValue = Number(right?.[key] ?? 0);

        if (key === "protein") {
            return rightValue - leftValue;
        }

        return leftValue - rightValue;
    });

    return a;
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (_, __, callback) => {
            ensureCustomImageStorage();
            callback(null, CUSTOM_IMAGES_DIR);
        },
        filename: (req, file, callback) => {
            const extName = path.extname(file.originalname || ".png").toLowerCase() || ".png";
            const safeBarcode = String(req.params.barcode || "product").replace(/[^a-zA-Z0-9_-]/g, "_");
            const filename = `${safeBarcode}-${Date.now()}-${Math.random().toString(16).slice(2)}${extName}`;
            callback(null, filename);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_, file, callback) => {
        if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP"));
            return;
        }

        callback(null, true);
    }
});

app.post("/api/products/:barcode/image", upload.single("image"), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "กรุณาเลือกไฟล์รูปภาพ" });
        }

        const barcode = String(req.params.barcode || "").trim();
        const imageUrl = `/images/products/${req.file.filename}`;

        if (barcode) {
            customImageMap[barcode] = imageUrl;
            saveCustomImageMap();
        }

        return res.json({
            ok: true,
            barcode,
            imageUrl,
            customImage: imageUrl
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || "ไม่สามารถบันทึกรูปภาพได้" });
    }
});

app.delete("/api/products/:barcode/image", (req, res) => {
    try {
        const barcode = String(req.params.barcode || "").trim();
        const currentImage = barcode ? customImageMap[barcode] : "";

        if (currentImage) {
            const fileName = path.basename(currentImage);
            const filePath = path.join(CUSTOM_IMAGES_DIR, fileName);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            delete customImageMap[barcode];
            saveCustomImageMap();
        }

        return res.json({ ok: true, barcode, removed: Boolean(currentImage) });
    } catch (error) {
        return res.status(500).json({ error: error.message || "ไม่สามารถคืนค่ารูปภาพได้" });
    }
});

const scannerImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_, file, callback) => {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("รองรับไฟล์ภาพ JPG, PNG หรือ WEBP เท่านั้น"));
            return;
        }
        callback(null, true);
    }
}).single("image");

function isSupportedImageBuffer(file) {
    if (file.mimetype === "image/jpeg") {
        return file.buffer.length >= 3
            && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
    }
    if (file.mimetype === "image/png") {
        return file.buffer.length >= 8
            && file.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    return file.mimetype === "image/webp"
        && file.buffer.length >= 12
        && file.buffer.toString("ascii", 0, 4) === "RIFF"
        && file.buffer.toString("ascii", 8, 12) === "WEBP";
}

function allowAiImageAnalysis(req, res) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let attempt = aiAnalyzeAttempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
        attempt = { count: 0, resetAt: now + 10 * 60 * 1000 };
        aiAnalyzeAttempts.set(key, attempt);
    }
    if (aiAnalyzeAttempts.size > 2000) {
        const oldestKey = aiAnalyzeAttempts.keys().next().value;
        if (oldestKey !== undefined && oldestKey !== key) aiAnalyzeAttempts.delete(oldestKey);
    }
    if (attempt.count >= 8) {
        res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
        res.status(429).json({ error: "วิเคราะห์ภาพครบจำนวนครั้งชั่วคราวแล้ว กรุณารอสักครู่แล้วลองใหม่" });
        return false;
    }
    attempt.count += 1;
    return true;
}

app.post("/api/ai/analyze-cat", (req, res, next) => {
    if (rejectCrossOriginRequest(req, res)) return;
    let user;
    try {
        user = getAuthenticatedUser(req, res);
    } catch (error) {
        console.error("Unable to verify the account for AI image analysis:", error.message);
        return res.status(500).json({ error: "ตรวจสอบบัญชีก่อนวิเคราะห์ภาพไม่สำเร็จ" });
    }
    if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบก่อนวิเคราะห์ภาพ" });
    if (!GEMINI_API_KEY) {
        return res.status(503).json({ error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env ของเซิร์ฟเวอร์" });
    }
    if (!allowAiImageAnalysis(req, res)) return;

    scannerImageUpload(req, res, (error) => {
        if (error) {
            const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
            return res.status(tooLarge ? 413 : 400).json({
                error: tooLarge ? "รูปภาพต้องมีขนาดไม่เกิน 5 MB" : error.message
            });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "กรุณาเลือกไฟล์รูปภาพ" });
    if (!isSupportedImageBuffer(req.file)) {
        return res.status(400).json({ error: "ไฟล์ภาพไม่ถูกต้องหรือชนิดไฟล์ไม่ตรงกับข้อมูลภาพ" });
    }

    const prompt = [
        "วิเคราะห์ภาพที่แนบเพื่อช่วยให้เจ้าของแมวเข้าใจลักษณะที่มองเห็นเท่านั้น",
        "ตอบเป็นภาษาไทย กระชับ ตรงตามภาพ และห้ามเดาสิ่งที่มองไม่เห็น",
        "ประเมินสายพันธุ์อย่างระมัดระวัง หากยืนยันไม่ได้ให้ระบุว่าไม่สามารถระบุได้",
        "อายุเป็นเพียงช่วงโดยประมาณจากลักษณะที่เห็น หากไม่ชัดให้ระบุว่าไม่สามารถประเมินได้",
        "ห้ามวินิจฉัยโรค ระบุอาการป่วย หรืออ้างว่าภาพยืนยันสุขภาพได้",
        "จำแนกภาพเป็น imageType ค่า cat เมื่อเห็นแมว, not_cat เมื่อเห็นชัดว่าไม่มีแมว, หรือ uncertain เมื่อภาพไม่ชัดหรือบอกไม่ได้",
        "ห้ามจัดภาพ uncertain เป็น not_cat และห้ามเดาข้อมูลแมวถ้าภาพไม่มีแมว",
        "ให้คำแนะนำทั่วไปที่ปลอดภัย ไม่แทนคำแนะนำจากสัตวแพทย์"
    ].join(" ");

    try {
        const upstream = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": GEMINI_API_KEY
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            {
                                inline_data: {
                                    mime_type: req.file.mimetype,
                                    data: req.file.buffer.toString("base64")
                                }
                            }
                        ]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                imageType: { type: "STRING", enum: ["cat", "not_cat", "uncertain"] },
                                breed: { type: "STRING" },
                                colorPattern: { type: "STRING" },
                                ageEstimate: { type: "STRING" },
                                description: { type: "STRING" },
                                careTips: { type: "STRING" }
                            },
                            required: ["imageType", "breed", "colorPattern", "ageEstimate", "description", "careTips"]
                        }
                    }
                }),
                signal: AbortSignal.timeout(180000)
            }
        );

        if (!upstream.ok) {
            console.error(`Gemini cat-image analysis failed with HTTP ${upstream.status}.`);
            return res.status(upstream.status === 429 ? 503 : 502).json({
                error: upstream.status === 429
                    ? "บริการ AI กำลังมีผู้ใช้งานมาก กรุณารอสักครู่แล้วลองใหม่"
                    : "บริการ AI วิเคราะห์ภาพไม่สำเร็จ กรุณาลองใหม่ภายหลัง"
            });
        }

        const result = await upstream.json();
        const responseText = result.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("")
            .trim();
        if (!responseText) {
            return res.status(502).json({ error: "AI ไม่สามารถอ่านภาพนี้ได้ กรุณาเลือกรูปอื่น" });
        }

        let analysis;
        try {
            analysis = JSON.parse(responseText);
        } catch (error) {
            console.error("Gemini returned an invalid structured cat-image analysis.");
            return res.status(502).json({ error: "AI ส่งผลวิเคราะห์ในรูปแบบที่ไม่ถูกต้อง กรุณาลองใหม่" });
        }

        if (!["cat", "not_cat", "uncertain"].includes(analysis.imageType)) {
            return res.status(502).json({ error: "AI ส่งผลตรวจสอบชนิดภาพไม่ครบ กรุณาลองใหม่" });
        }
        const fields = ["breed", "colorPattern", "ageEstimate", "description", "careTips"];
        if (fields.some((field) => typeof analysis[field] !== "string" || !analysis[field].trim())) {
            return res.status(502).json({ error: "AI ส่งผลวิเคราะห์ไม่ครบ กรุณาลองใหม่" });
        }
        return res.json({
            ok: true,
            analysis: {
                imageType: analysis.imageType,
                ...Object.fromEntries(fields.map((field) => [field, analysis[field].trim().slice(0, 600)]))
            }
        });
    } catch (error) {
        if (error.name === "TimeoutError") {
            return res.status(504).json({ error: "AI ใช้เวลาวิเคราะห์เกิน 3 นาที กรุณาลองใหม่" });
        }
        console.error("Gemini cat-image analysis request failed:", error.message);
        return res.status(502).json({ error: "เชื่อมต่อบริการ AI ไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.get("/api/cat/images", requireAuthenticatedApi, async (req, res) => {
    const rawLimit = req.query.limit === undefined ? "1" : req.query.limit;
    if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
        return res.status(400).json({ error: "จำนวนรูปภาพไม่ถูกต้อง" });
    }

    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
        return res.status(400).json({ error: "จำนวนรูปภาพต้องอยู่ระหว่าง 1 ถึง 5 รูป" });
    }

    try {
        const url = new URL("https://api.thecatapi.com/v1/images/search");
        url.search = new URLSearchParams({
            limit: String(limit),
            mime_types: "jpg,png"
        }).toString();
        const headers = {};
        if (THECATAPI_API_KEY) headers["x-api-key"] = THECATAPI_API_KEY;

        const upstream = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(12000)
        });
        if (!upstream.ok) {
            console.error(`TheCatAPI image request failed with HTTP ${upstream.status}.`);
            return res.status(upstream.status === 429 ? 503 : 502).json({
                error: upstream.status === 429
                    ? "TheCatAPI กำลังมีผู้ใช้งานมาก กรุณาลองใหม่ภายหลัง"
                    : "โหลดรูปแมวจาก TheCatAPI ไม่สำเร็จ กรุณาลองใหม่"
            });
        }

        const result = await upstream.json();
        const images = Array.isArray(result)
            ? result.filter((item) => item && typeof item.url === "string" && item.url.startsWith("https://"))
                .slice(0, limit)
                .map((item) => ({ url: item.url }))
            : [];
        if (images.length === 0) {
            console.error("TheCatAPI returned no valid image URLs.");
            return res.status(502).json({ error: "TheCatAPI ไม่พบรูปแมวที่ใช้งานได้ กรุณาลองใหม่" });
        }
        return res.json(images);
    } catch (error) {
        if (error.name === "TimeoutError") {
            return res.status(504).json({ error: "TheCatAPI ใช้เวลาตอบกลับนานเกินไป กรุณาลองใหม่" });
        }
        console.error("Unable to request cat images from TheCatAPI:", error.message);
        return res.status(502).json({ error: "เชื่อมต่อ TheCatAPI ไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.get("/api/auth/providers", (_, res) => {
    res.json({
        ok: true,
        providers: {
            google: isOAuthProviderConfigured("google"),
            line: isOAuthProviderConfigured("line"),
            facebook: isOAuthProviderConfigured("facebook")
        }
    });
});

app.get("/api/auth/me", (req, res) => {
    try {
        const user = getAuthenticatedUser(req, res);
        res.json({ ok: true, user: user ? publicAuthUser(user) : null });
    } catch (error) {
        console.error("Failed to load the authentication session:", error.message);
        res.status(500).json({ error: "ไม่สามารถตรวจสอบสถานะบัญชีได้" });
    }
});

app.get("/api/care/schedule", (req, res) => {
    try {
        const user = getAuthenticatedUser(req, res);
        if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบเพื่อดูข้อมูลการดูแล" });

        const schedules = readCareSchedules();
        const hasSchedule = Object.prototype.hasOwnProperty.call(schedules, user.id);
        return res.json({
            ok: true,
            hasSchedule,
            schedule: hasSchedule ? schedules[user.id] : { reminders: [], checklists: {} }
        });
    } catch (error) {
        console.error("Failed to load the PawCare schedule:", error.message);
        return res.status(500).json({ error: "โหลดข้อมูลการดูแลไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.put("/api/care/schedule", (req, res) => {
    if (rejectCrossOriginRequest(req, res)) return;

    try {
        const user = getAuthenticatedUser(req, res);
        if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบก่อนบันทึกข้อมูลการดูแล" });

        const schedule = validateCareSchedule(req.body);
        if (!schedule) return res.status(400).json({ error: "รูปแบบข้อมูลการดูแลไม่ถูกต้อง" });
        if (Buffer.byteLength(JSON.stringify(schedule), "utf8") > 1024 * 1024) {
            return res.status(413).json({ error: "ข้อมูลการดูแลมีขนาดใหญ่เกินไป" });
        }

        const schedules = readCareSchedules();
        schedules[user.id] = schedule;
        writeAuthJson(CARE_SCHEDULES_PATH, schedules);
        return res.json({ ok: true, schedule });
    } catch (error) {
        console.error("Failed to save the PawCare schedule:", error.message);
        return res.status(500).json({ error: "บันทึกข้อมูลการดูแลไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.get("/api/cat/profile", (req, res) => {
    try {
        const user = getAuthenticatedUser(req, res);
        if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบเพื่อดูโปรไฟล์แมว" });

        const profiles = readCatProfiles();
        const hasProfile = Object.prototype.hasOwnProperty.call(profiles, user.id);
        return res.json({
            ok: true,
            hasProfile,
            profile: hasProfile ? profiles[user.id] : { name: "", age: "", breed: "", sex: "unspecified", photo: null }
        });
    } catch (error) {
        console.error("Failed to load the cat profile:", error.message);
        return res.status(500).json({ error: "โหลดโปรไฟล์แมวไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.put("/api/cat/profile", (req, res) => {
    if (rejectCrossOriginRequest(req, res)) return;

    try {
        const user = getAuthenticatedUser(req, res);
        if (!user) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบก่อนบันทึกโปรไฟล์แมว" });

        const profile = validateCatProfile(req.body);
        if (!profile) return res.status(400).json({ error: "ข้อมูลโปรไฟล์แมวไม่ถูกต้อง" });

        const profiles = readCatProfiles();
        profiles[user.id] = profile;
        writeAuthJson(CAT_PROFILES_PATH, profiles);
        return res.json({ ok: true, profile });
    } catch (error) {
        console.error("Failed to save the cat profile:", error.message);
        return res.status(500).json({ error: "บันทึกโปรไฟล์แมวไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.post("/api/auth/register", async (req, res) => {
    if (rejectCrossOriginRequest(req, res)) return;
    if (checkAuthRateLimit(req, res)) return;

    try {
        const name = String(req.body && req.body.name || "").trim();
        const email = normalizeEmail(req.body && req.body.email);
        const password = String(req.body && req.body.password || "");
        if (name.length < 2 || name.length > 60) {
            return res.status(400).json({ error: "กรุณากรอกชื่อ 2–60 ตัวอักษร" });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: "กรุณากรอกอีเมลให้ถูกต้อง" });
        }
        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({ error: "รหัสผ่านต้องมีความยาว 8–128 ตัวอักษร" });
        }

        const users = readAuthJson(AUTH_USERS_PATH, []);
        if (users.some((user) => normalizeEmail(user.email) === email)) {
            return res.status(409).json({
                code: "ACCOUNT_EXISTS",
                error: "อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบ"
            });
        }

        const user = {
            id: crypto.randomUUID(),
            name,
            email,
            passwordHash: await hashPassword(password),
            providers: {},
            createdAt: new Date().toISOString()
        };
        users.push(user);
        writeAuthJson(AUTH_USERS_PATH, users);
        createAuthSession(res, user, true);
        clearAuthRateLimit(req);
        return res.status(201).json({ ok: true, user: publicAuthUser(user) });
    } catch (error) {
        console.error("Account registration failed:", error.message);
        return res.status(500).json({ error: "สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.post("/api/auth/login", async (req, res) => {
    if (rejectCrossOriginRequest(req, res)) return;
    if (checkAuthRateLimit(req, res)) return;

    try {
        const email = normalizeEmail(req.body && req.body.email);
        const password = String(req.body && req.body.password || "");
        if (!isValidEmail(email) || password.length > 128) {
            return res.status(401).json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        const users = readAuthJson(AUTH_USERS_PATH, []);
        const user = users.find((item) => item.email === email && item.passwordHash);
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            return res.status(401).json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        createAuthSession(res, user, Boolean(req.body && req.body.remember));
        clearAuthRateLimit(req);
        return res.json({ ok: true, user: publicAuthUser(user) });
    } catch (error) {
        console.error("Account login failed:", error.message);
        return res.status(500).json({ error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่" });
    }
});

app.post("/api/auth/logout", (req, res) => {
    if (rejectCrossOriginRequest(req, res)) return;

    try {
        const token = parseCookies(req)[AUTH_SESSION_COOKIE];
        if (token) {
            const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
            const sessions = readAuthJson(AUTH_SESSIONS_PATH, []);
            writeAuthJson(AUTH_SESSIONS_PATH, sessions.filter((session) => session.tokenHash !== tokenHash));
        }
        clearCookie(res, AUTH_SESSION_COOKIE);
        return res.json({ ok: true });
    } catch (error) {
        console.error("Account logout failed:", error.message);
        return res.status(500).json({ error: "ออกจากระบบไม่สำเร็จ กรุณาลองใหม่" });
    }
});

function startOAuth(provider, req, res) {
    const config = getOAuthProviderConfig(provider);
    if (!config || !isOAuthProviderConfigured(provider)) {
        if (req.query.popup === "1") {
            return sendOAuthPopupResult(res, { ok: false, error: `${provider}_not_configured` }, provider);
        }
        return redirectAuthError(res, `${provider}_not_configured`);
    }

    const state = crypto.randomBytes(32).toString("base64url");
    const cookieName = `${AUTH_STATE_COOKIE_PREFIX}${provider}`;
    const stateCookie = Buffer.from(JSON.stringify({ state, popup: req.query.popup === "1" })).toString("base64url");
    res.append("Set-Cookie", serializeCookie(cookieName, stateCookie, 10 * 60));

    const authorizationUrl = new URL(config.authorizationUrl);
    authorizationUrl.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: config.scope,
        state
    }).toString();
    return res.redirect(authorizationUrl.toString());
}

function sendOAuthPopupResult(res, result, provider) {
    const config = getOAuthProviderConfig(provider);
    const targetOrigin = new URL(config.redirectUri).origin;
    const safeResult = JSON.stringify({ type: "meow-auth", ...result }).replace(/[<>&]/g, (character) => ({
        "<": "\\u003c",
        ">": "\\u003e",
        "&": "\\u0026"
    })[character]);

    res.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.set("Referrer-Policy", "no-referrer");
    return res.type("html").send(`<!doctype html><html lang="th"><meta charset="utf-8"><title>Meow Museum</title><body><p>กำลังกลับไปที่ Meow Museum...</p><script>if(window.opener){window.opener.postMessage(${safeResult},${JSON.stringify(targetOrigin)});window.close()}else{document.querySelector('p').textContent=${JSON.stringify(result.ok ? "เชื่อมต่อสำเร็จ กรุณากลับไปยังหน้า Meow Museum" : "เชื่อมต่อไม่สำเร็จ กรุณากลับไปลองใหม่")}</script></body></html>`);
}

async function finishOAuth(provider, req, res) {
    const cookieName = `${AUTH_STATE_COOKIE_PREFIX}${provider}`;
    const storedState = parseCookies(req)[cookieName];
    clearCookie(res, cookieName);

    let stateData;
    try {
        stateData = JSON.parse(Buffer.from(storedState || "", "base64url").toString("utf8"));
    } catch (error) {
        stateData = { state: "", popup: false };
    }
    const expectedState = typeof stateData.state === "string" ? stateData.state : "";
    const popup = stateData.popup === true;
    const sendFailure = (error) => popup
        ? sendOAuthPopupResult(res, { ok: false, error }, provider)
        : redirectAuthError(res, error);

    const receivedState = typeof req.query.state === "string" ? req.query.state : "";
    if (!expectedState || !receivedState || expectedState.length !== receivedState.length ||
        !crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(receivedState))) {
        return sendFailure("oauth_state_invalid");
    }
    if (req.query.error || typeof req.query.code !== "string" || !req.query.code) {
        return sendFailure("oauth_cancelled");
    }

    try {
        const profile = await exchangeOAuthIdentity(provider, req.query.code);
        const user = findOrCreateOAuthUser(provider, profile);
        createAuthSession(res, user, true);
        if (popup) {
            return sendOAuthPopupResult(res, { ok: true, user: publicAuthUser(user) }, provider);
        }
        return res.redirect("/?auth=success");
    } catch (error) {
        console.error(`${provider} sign-in failed:`, error.message);
        return sendFailure("oauth_failed");
    }
}

app.get("/auth/google", (req, res) => startOAuth("google", req, res));
app.get("/auth/google/callback", (req, res) => finishOAuth("google", req, res));
app.get("/auth/line", (req, res) => startOAuth("line", req, res));
app.get("/auth/line/callback", (req, res) => finishOAuth("line", req, res));
app.get("/auth/facebook", (req, res) => startOAuth("facebook", req, res));
app.get("/auth/facebook/callback", (req, res) => finishOAuth("facebook", req, res));

app.get("/api/edited-products", requireAuthenticatedApi, (_, res) => {
    const payload = loadEditedProductsMap();
    res.json({ ok: true, data: payload });
});

app.post("/api/edited-products", requireAuthenticatedApi, (req, res) => {
    try {
        const incoming = req.body && typeof req.body === "object" ? req.body : {};
        const merged = { ...loadEditedProductsMap(), ...incoming };
        saveEditedProductsMap(merged);
        res.json({ ok: true, data: merged });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message || "ไม่สามารถบันทึกข้อมูลที่แก้ไขได้" });
    }
});

app.get("/api/products/search", async (req, res) => {
    const searchTerms = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);
    if (searchTerms.length < 2 || searchTerms.length > 100) {
        return res.status(400).json({ error: "กรุณากรอกคำค้นหาความยาว 2-100 ตัวอักษร" });
    }
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
        return res.status(400).json({ error: "หมายเลขหน้าค้นหาไม่ถูกต้อง" });
    }

    const url = new URL("https://world.openfoodfacts.org/api/v2/search");
    url.search = new URLSearchParams({
        search_terms: searchTerms,
        sort_by: "unique_scans_n",
        page: String(page),
        page_size: "24",
        fields: "product_name,product_name_en,product_name_th,generic_name,brands,code,image_front_url,image_front_small_url,image_url,image_front_thumb_url,selected_images,nutriments,ingredients_text,ingredients_text_th,ingredients_text_en,nutriscore_grade,nutrition_grades,flavor,flavour,quantity"
    }).toString();

    try {
        const response = await fetch(url.toString(), {
            headers: {
                "User-Agent": "FoodCheck/1.0 (student-project)",
                "Accept": "application/json",
                "Accept-Language": "th,en-US;q=0.9,en;q=0.8"
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            return res.status(502).json({ error: `Open Food Facts ตอบกลับด้วยสถานะ ${response.status}` });
        }

        const result = await response.json();
        const products = Array.isArray(result.products) ? result.products : [];
        const data = products
            .map((product) => normalizeFoodRecord(product))
            .filter((product) => product.name && product.name !== "-");
        return res.json({
            data,
            page: Number(result.page || page),
            totalPages: Number(result.page_count || 1),
            count: Number(result.count || data.length)
        });
    } catch (error) {
        console.error("Open Food Facts product search failed:", error);
        return res.status(502).json({ error: "เชื่อมต่อ Open Food Facts ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }
});

app.get("/foods", (req, res) => {
    const algo = req.query.sort || "sugar";
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Number(req.query.limit || 12));
    const start = performance.now();

    let sorted = [...foods];
    if (algo === "protein") {
        sorted = sortByMetric(sorted, "protein");
    } else if (algo === "fat") {
        sorted = sortByMetric(sorted, "fat");
    } else if (algo === "sugar") {
        sorted = sortByMetric(sorted, "sugar");
    } else if (algo === "insertion") {
        sorted = insertionSort(sorted);
    } else if (algo === "bubble") {
        sorted = bubbleSort(sorted);
    } else {
        sorted = selectionSort(sorted);
    }

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const sliceStart = (page - 1) * limit;
    const pageItems = sorted.slice(sliceStart, sliceStart + limit);
    const ms = (performance.now() - start).toFixed(3);

    res.json({
        algorithm: algo,
        count: total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
        ms,
        data: pageItems.map((food) => {
            const imageKey = String(food.barcode && food.barcode !== "-" ? food.barcode : food.id || "").trim();
            const customImage = customImageMap[imageKey] || food.customImage || "";
            if (!customImage) return food;
            return {
                ...food,
                originalImage: food.originalImage || food.apiImage || food.image || "",
                image: customImage,
                customImage
            };
        })
    });
});

loadCustomImageMap();
loadEditedProductsMap();

app.listen(PORT, () => {
    console.log(`FoodCheck running at http://localhost:${PORT}`);
});

loadFoods()
    .then(() => {
        console.log(`FoodCheck inventory ready: ${foods.length} products loaded`);
    })
    .catch((error) => {
        console.error("Failed to load Open Food Facts data:", error.message);
        foods = createBuiltInFoodCatalog();
        console.log(`FoodCheck running at http://localhost:${PORT} with demo inventory`);
    });