async function searchFood() {

    const keyword = document.getElementById("searchInput").value;

    if (keyword === "") {
        alert("กรุณาพิมพ์ชื่ออาหาร");
        return;
    }

    const url = new URL("https://world.openfoodfacts.org/api/v2/search");
    url.search = new URLSearchParams({
        search_terms: keyword,
        page_size: "10",
        fields: "product_name,brands,image_front_small_url,nutriments"
    }).toString();

    const response = await fetch(url.toString());
    const data = await response.json();

    const foodList = document.getElementById("foodList");

    foodList.innerHTML = "";

    data.products.forEach(food => {

        const item = document.createElement("div");

        item.innerHTML = `
            <img 
                src="${food.image_front_small_url || ""}" 
                width="120"
            >

            <h3>
                ${food.product_name || "ไม่พบชื่อสินค้า"}
            </h3>

            <p>
                แบรนด์: ${food.brands || "ไม่พบข้อมูล"}
            </p>

            <p>
                พลังงาน:
                ${food.nutriments?.["energy-kcal_100g"] || "ไม่มีข้อมูล"}
                kcal / 100g
            </p>

            <p>
                น้ำตาล:
                ${food.nutriments?.sugars_100g || "ไม่มีข้อมูล"}
                g / 100g
            </p>

            <p>
                ไขมัน:
                ${food.nutriments?.fat_100g || "ไม่มีข้อมูล"}
                g / 100g
            </p>
        `;

        foodList.appendChild(item);
    });
}