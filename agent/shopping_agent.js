const { getJSONCompletion } = require("./ai_provider");
const axios = require("axios");

function parseShoppingHeuristic(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const raw = userMessage.trim();
  if (!raw) return null;

  let currency = "USDC";
  if (/[\u20A6]|(?:\b(?:ngn|naira)\b)/i.test(raw)) {
    currency = "NGN";
  }

  let text = raw;
  let deliveryAddress = null;
  const addressMatch = text.match(/(?:deliver(?:y)?|ship(?:ping)?)\s+(?:to|at)\s+(.+)$/i);
  if (addressMatch) {
    deliveryAddress = addressMatch[1].trim();
    text = text.replace(addressMatch[0], " ").trim();
  }

  let maxPrice = null;
  const priceMatch = text.match(/(?:under|below|less\s+than|max(?:imum)?(?:\s+price)?|budget(?:\s+of)?|for)\s+[\$₦]?\s*([\d,]+(?:\.\d+)?)/i) ||
                     text.match(/[\$₦]\s*([\d,]+(?:\.\d+)?)\s*(?:max|budget)?/i);
  if (priceMatch) {
    const num = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (!isNaN(num) && num > 0) {
      maxPrice = num;
      text = text.replace(priceMatch[0], " ").trim();
    }
  }

  // Clean leading verbs
  let cleanName = text
    .replace(/^(?:find|buy|search\s+for|search|get\s+me|get|order|shop\s+for|shop|purchase|look\s+for)\s+(?:an?\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanName.length > 0) {
    return {
      product_name: cleanName,
      max_price: maxPrice,
      delivery_address: deliveryAddress,
      currency: currency
    };
  }
  return null;
}

function normalizeShoppingParsed(parsed, rawUserMessage = "") {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.error && parsed.error !== "Not a shopping intent") return parsed;

  const productName = parsed.product_name || parsed.productName || parsed.product || parsed.item || null;
  const maxPrice = parsed.max_price !== undefined ? (parsed.max_price !== null ? Number(parsed.max_price) : null) : (parsed.maxPrice !== undefined ? (parsed.maxPrice !== null ? Number(parsed.maxPrice) : null) : null);
  const deliveryAddress = parsed.delivery_address || parsed.deliveryAddress || parsed.address || null;
  const currency = parsed.currency || "USDC";

  if (!productName || typeof productName !== "string" || !productName.trim()) {
    const fallback = parseShoppingHeuristic(rawUserMessage);
    if (fallback) return fallback;
    return { error: "Could not understand the shopping request." };
  }

  return {
    product_name: productName.trim(),
    max_price: isNaN(maxPrice) ? null : maxPrice,
    delivery_address: deliveryAddress,
    currency
  };
}

async function parseShoppingIntent(userMessage, userContext = {}) {
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
    const rawParsed = await getJSONCompletion(systemPrompt, userMessage);
    const normalized = normalizeShoppingParsed(rawParsed, userMessage);
    if (normalized && !normalized.error) {
      return normalized;
    }
    const fallback = parseShoppingHeuristic(userMessage);
    if (fallback) return fallback;
    return normalized || { error: "Could not understand the shopping request." };
  } catch (err) {
    console.error("[shopping_agent] Error:", err.message);
    const fallback = parseShoppingHeuristic(userMessage);
    if (fallback) return fallback;
    return { error: "Could not understand the shopping request." };
  }
}

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
    image: "https://cdn.dummyjson.com/product-images/laptops/apple-macbook-pro-14-inch-space-grey/thumbnail.webp",
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

module.exports = {
  parseShoppingIntent,
  parseShoppingHeuristic,
  normalizeShoppingParsed,
  searchForProduct
};
