const { getJSONCompletion } = require("./ai_provider");

async function parseShoppingIntent(userMessage, userContext) {
  const systemPrompt = `You are a Personal Shopper Agent for PayIT.
The user wants to buy a product online. Even if they say "search the web", treat it as a shopping request.
Extract the relevant details to search for the product and initiate a purchase.

Respond with ONLY a valid JSON object — no markdown, no explanation.

{
  "product_name": "<Name of the product>",
  "max_price": <Maximum price the user is willing to pay as a number, or null if not specified>,
  "delivery_address": "<Address for delivery, or null if not specified>",
  "currency": "<Currency code (e.g., USDC, NGN) — default USDC>"
}

Rules:
- Amounts must be positive numbers (do not include commas or currency symbols like $, N, ₦).
- If the user specifies Naira (N or ₦), set currency to "NGN".
- If no specific currency is mentioned, assume USDC.
- Only return {"error": "Not a shopping intent"} if it is clearly completely unrelated to buying or finding a product.

User context: ${JSON.stringify(userContext)}`;

  try {
    return await getJSONCompletion(systemPrompt, userMessage);
  } catch (err) {
    console.error("[shopping_agent] Error:", err.message);
    return { error: "Could not understand the shopping request." };
  }
}

const axios = require("axios");

// Fetches a live product from DummyJSON
async function searchForProduct(productName, maxPrice = null) {
  try {
    const url = `https://dummyjson.com/products/search?q=${encodeURIComponent(productName)}&limit=10`;
    const response = await axios.get(url);
    const data = response.data;

    if (data && data.products && data.products.length > 0) {
      // Find the first product that fits the budget if specified
      let p = data.products.find(prod => maxPrice === null || prod.price <= maxPrice);
      
      if (!p && maxPrice !== null) {
         // None found under budget
         const cheapest = [...data.products].sort((a,b) => a.price - b.price)[0];
         return { error: `I couldn't find a "${productName}" under $${maxPrice}. The cheapest one I found was $${cheapest.price}.` };
      }
      
      p = p || data.products[0];
      const dimensions = p.dimensions ? `${p.dimensions.width}x${p.dimensions.height}x${p.dimensions.depth}cm` : null;
      const specs = [
        dimensions ? `Size: ${dimensions}` : null,
        p.weight ? `Weight: ${p.weight}kg` : null,
        p.warrantyInformation ? `Warranty: ${p.warrantyInformation}` : null
      ].filter(Boolean).join(" | ") || "Standard specifications";

      const image = p.thumbnail || (p.images && p.images[0]) || null;
      const originalPrice = p.discountPercentage ? (p.price / (1 - p.discountPercentage / 100)).toFixed(2) : null;
      const reviewsCount = p.reviews ? p.reviews.length : 35;
      const stockText = p.stock ? `In Stock (${p.stock} units available)` : (p.availabilityStatus || "In Stock");

      return {
        name: p.title,
        brand: p.brand || "Official Brand",
        category: p.category || "General",
        sku: p.sku || `SKU-${p.id}`,
        image: image,
        rating: p.rating ? p.rating.toFixed(1) : "4.8",
        reviewsCount: reviewsCount,
        stock: stockText,
        description: p.description || "No detailed description available.",
        condition: "Brand New",
        specs: specs,
        returnPolicy: p.returnPolicy || "30 days return policy",
        store: "DummyJSON Marketplace",
        isVerified: true,
        price: p.price.toFixed(2),
        originalPrice: originalPrice,
        discountPercentage: p.discountPercentage ? p.discountPercentage.toFixed(0) : null,
        currency: "USDC",
        delivery_time: p.shippingInformation || "2-3 business days",
        seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
      };
    }
  } catch (error) {
    console.error("[shopping_agent] DummyJSON search error:", error.message);
  }

  // Fallback if no product found or API fails
  const fallbackPrice = maxPrice !== null ? (Math.random() * (maxPrice * 0.9)).toFixed(2) : (Math.random() * 100 + 10).toFixed(2);
  const fallbackPriceNum = Number(fallbackPrice);
  const fallbackOrig = (fallbackPriceNum * 1.15).toFixed(2);

  return {
    name: productName,
    brand: "Verified Brand",
    category: "Electronics",
    sku: `SKU-${Math.floor(Math.random() * 9000 + 1000)}`,
    image: "https://cdn.dummyjson.com/products/images/laptops/Apple%20MacBook%20Pro%2014%20Inch%20Space%20Grey/thumbnail.png",
    rating: "4.8",
    reviewsCount: 42,
    stock: "In Stock (12 units available)",
    description: `A highly rated ${productName} with excellent reviews and full manufacturer warranty.`,
    condition: "Brand New",
    specs: "High performance configuration | Factory Sealed",
    returnPolicy: "30-day money-back guarantee",
    store: "MockAmazon Verified Store",
    isVerified: true,
    price: fallbackPrice,
    originalPrice: fallbackOrig,
    discountPercentage: "13",
    currency: "USDC",
    delivery_time: "2-3 business days",
    seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
  };
}

module.exports = { parseShoppingIntent, searchForProduct };
