const { getJSONCompletion } = require("./ai_provider");

async function parseShoppingIntent(userMessage, userContext) {
  const systemPrompt = `You are a Personal Shopper Agent for PayIT.
The user wants to buy a product online.
Extract the relevant details to search for the product and initiate a purchase.

Respond with ONLY a valid JSON object — no markdown, no explanation.

{
  "product_name": "<Name of the product>",
  "max_price": <Maximum price the user is willing to pay, or null if not specified>,
  "delivery_address": "<Address for delivery, or null if not specified>",
  "currency": "<USDC | EURC — default USDC>"
}

Rules:
- Amounts must be positive numbers.
- If no specific currency is mentioned, assume USDC.
- If the user intent is not about shopping, return {"error": "Not a shopping intent"}.

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
      return {
        name: p.title,
        store: "DummyJSON Marketplace",
        price: p.price.toFixed(2),
        currency: "USDC",
        delivery_time: "2-3 business days",
        seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
      };
    }
  } catch (error) {
    console.error("[shopping_agent] DummyJSON search error:", error.message);
  }

  // Fallback if no product found or API fails
  return {
    name: productName,
    store: "MockAmazon (Fallback)",
    price: (Math.random() * 100 + 10).toFixed(2),
    currency: "USDC",
    delivery_time: "2-3 business days",
    seller_wallet: "0x1234567890abcdef1234567890abcdef12345678" // dummy seller address
  };
}

module.exports = { parseShoppingIntent, searchForProduct };
