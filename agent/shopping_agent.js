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
async function searchForProduct(productName) {
  try {
    const url = `https://dummyjson.com/products/search?q=${encodeURIComponent(productName)}&limit=1`;
    const response = await axios.get(url);
    const data = response.data;

    if (data && data.products && data.products.length > 0) {
      const p = data.products[0];
      const dimensions = p.dimensions ? `${p.dimensions.width}x${p.dimensions.height}x${p.dimensions.depth}cm` : null;
      const specs = [
        dimensions ? `Size: ${dimensions}` : null,
        p.weight ? `Weight: ${p.weight}` : null,
        p.warrantyInformation ? `Warranty: ${p.warrantyInformation}` : null
      ].filter(Boolean).join(" | ") || "Not specified";

      return {
        name: p.title,
        description: p.description || "No description available.",
        condition: "Brand New",
        specs: specs,
        returnPolicy: p.returnPolicy || "No return policy specified",
        store: "DummyJSON Marketplace",
        price: p.price.toFixed(2),
        currency: "USDC",
        delivery_time: p.shippingInformation || "2-3 business days",
        seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
      };
    }
  } catch (error) {
    console.error("[shopping_agent] DummyJSON search error:", error.message);
  }

  // Fallback if no product found or API fails
  return {
    name: productName,
    description: `A highly rated ${productName} with excellent reviews.`,
    condition: "Brand New",
    specs: "Standard configuration",
    returnPolicy: "30-day money-back guarantee",
    store: "MockAmazon (Fallback)",
    price: (Math.random() * 100 + 10).toFixed(2),
    currency: "USDC",
    delivery_time: "2-3 business days",
    seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
  };
}

module.exports = { parseShoppingIntent, searchForProduct };
