const TelegramBot = require('node-telegram-bot-api');
// 🛡️ GLOBAL ERROR HANDLER
process.on('unhandledRejection', (error) => {
console.error('🔴 Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
console.error('🔴 Uncaught Exception:', error);
});
// Get environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // @jumarket
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
if (!BOT_TOKEN) {
console.error('❌ BOT_TOKEN environment variable is required');
}
// Create bot instance (without polling)
const bot = new TelegramBot(BOT_TOKEN);
// ========== DATABASE (In-Memory) ========== //
const users = new Map();
const products = new Map();
const userStates = new Map();
let productIdCounter = 1;
// Categories for Jimma University
const CATEGORIES = [
'📚 Academic Books',
'💻 Electronics',
'👕 Clothes & Fashion',
'🏠 Furniture & Home',
'📝 Study Materials',
'🎮 Entertainment',
'🍔 Food & Drinks',
'🚗 Transportation',
'🎒 Accessories',
'❓ Others'
];
// ========== MAIN MENU ========== //
const showMainMenu = async (chatId) => {
const options = {
reply_markup: {
keyboard: [
[{ text: '🛍️ Browse Products' }, { text: '➕ Sell Item' }],
[{ text: '📋 My Products' }, { text: '📞 Contact Admin' }],
[{ text: 'ℹ️ Help' }]
],
resize_keyboard: true
}
};
await bot.sendMessage(chatId,
🏪 *Jimma University Marketplace*\n\n +
Welcome to JU Student Marketplace! 🎓\n\n +
Choose an option below:,
{ parse_mode: 'Markdown', ...options }
);
};
// ========== START COMMAND ========== //
const handleStart = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
// Register user
if (!users.has(userId)) {
users.set(userId, {
telegramId: userId,
username: msg.from.username || '',
firstName: msg.from.first_name,
joinedAt: new Date(),
department: '',
year: ''
});
}
await bot.sendMessage(chatId,
🎓 *Welcome to Jimma University Marketplace!*\n\n +
🏪 *Buy & Sell* within JU Community\n +
📚 Books, Electronics, Clothes & more\n +
🔒 Safe campus transactions\n +
📢 All products posted in @jumarket\n\n +
Start by browsing items or selling yours!,
{ parse_mode: 'Markdown' }
);
await showMainMenu(chatId);
};
// ========== BROWSE PRODUCTS ========== //
const handleBrowse = async (msg) => {
const chatId = msg.chat.id;
const approvedProducts = Array.from(products.values())
.filter(product => product.status === 'approved')
.slice(0, 10);
if (approvedProducts.length === 0) {
await bot.sendMessage(chatId,
🛍️ *Browse Products*\n\n +
No products available yet.\n\n +
Be the first to list an item! 💫\n +
Use "➕ Sell Item" to get started.,
{ parse_mode: 'Markdown' }
);
return;
}
await bot.sendMessage(chatId,
🛍️ *Available Products (${approvedProducts.length})*\n\n +
Latest items from JU students:,
{ parse_mode: 'Markdown' }
);
// Send each product
for (const product of approvedProducts) {
const seller = users.get(product.sellerId);
const browseKeyboard = { reply_markup: { inline_keyboard: [ [ { text: '🛒 Buy Now', callback_data: `buy_${product.id}` }, { text: '📞 Contact Seller', callback_data: `contact_${product.id}` } ], [ { text: '👀 View Details', callback_data: `details_${product.id}` } ] ] } }; try { await bot.sendPhoto(chatId, product.images[0], { caption: `🏷️ *${product.title}*\n\n` + `💰 *Price:* ${product.price} ETB\n` + `📦 *Category:* ${product.category}\n` + `👤 *Seller:* ${seller?.firstName || 'JU Student'}\n` + `${product.description ? `📝 *Description:* ${product.description}\n` : ''}` + `\n📍 *Campus Meetup*`, parse_mode: 'Markdown', reply_markup: browseKeyboard.reply_markup }); } catch (error) { // Fallback to text if image fails await bot.sendMessage(chatId, `🏷️ *${product.title}*\n\n` + `💰 *Price:* ${product.price} ETB\n` + `📦 *Category:* ${product.category}\n` + `👤 *Seller:* ${seller?.firstName || 'JU Student'}\n` + `${product.description ? `📝 *Description:* ${product.description}\n` : ''}`, { parse_mode: 'Markdown', reply_markup: browseKeyboard.reply_markup } ); } await new Promise(resolve => setTimeout(resolve, 300)); 
}
};
// ========== SELL ITEM ========== //
const handleSell = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
userStates.set(userId, {
state: 'awaiting_product_images',
productData: {}
});
await bot.sendMessage(chatId,
🛍️ *Sell Your Item - Step 1/5*\n\n +
📸 *Send Product Photos*\n\n +
Please send 1-5 photos of your item.\n +
You can send multiple images at once.,
{ parse_mode: 'Markdown' }
);
};
// ========== HELP COMMAND ========== //
const handleHelp = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
const isAdmin = ADMIN_IDS.includes(userId);
let helpMessage = ℹ️ *Jimma University Marketplace Help*\n\n +
*How to Buy:*\n +
1. Click "🛍️ Browse Products"\n +
2. View available items\n +
3. Click "🛒 Buy Now" or "📞 Contact Seller"\n +
4. Arrange campus meetup\n\n +
*How to Sell:*\n +
1. Click "➕ Sell Item"\n +
2. Send product photos (1-5 images)\n +
3. Add title, price, and description\n +
4. Select category\n +
5. Wait for admin approval\n +
6. Item appears in @jumarket channel\n\n +
*User Commands:*\n +
/start - Start the bot\n +
/help - Show this help\n +
/browse - Browse products\n +
/sell - List a new product\n +
/myproducts - View your products\n +
/status - Check statistics\n +
/contact - Contact administration\n;
if (isAdmin) {
helpMessage += \n*⚡ Admin Commands:*\n +
/admin - Admin panel\n +
/pending - Pending approvals\n +
/stats - Statistics\n +
/users - All users\n +
/allproducts - All products\n;
}
await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
};
// ========== MESSAGE HANDLER ========== //
const handleMessage = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
const text = msg.text;
if (!text) return;
// Handle commands
if (text.startsWith('/')) {
switch (text) {
case '/start':
await handleStart(msg);
break;
case '/help':
case 'ℹ️ Help':
await handleHelp(msg);
break;
case '/browse':
case '🛍️ Browse Products':
await handleBrowse(msg);
break;
case '/sell':
case '➕ Sell Item':
await handleSell(msg);
break;
case '/myproducts':
case '📋 My Products':
await handleMyProducts(msg);
break;
case '/contact':
case '📞 Contact Admin':
await handleContact(msg);
break;
case '/status':
await handleStatus(msg);
break;
default:
// Handle other commands or show main menu
await showMainMenu(chatId);
}
} else {
// Handle regular messages (product creation flow, etc.)
await handleRegularMessage(msg);
}
};
// ========== CALLBACK QUERY HANDLER ========== //
const handleCallbackQuery = async (callbackQuery) => {
const message = callbackQuery.message;
const userId = callbackQuery.from.id;
const data = callbackQuery.data;
const chatId = message.chat.id;
try {
// Handle different callback types
if (data.startsWith('buy_')) {
const productId = parseInt(data.replace('buy_', ''));
await handleBuyProduct(chatId, userId, productId, callbackQuery.id);
} else if (data.startsWith('contact_')) {
const productId = parseInt(data.replace('contact_', ''));
await handleContactSeller(chatId, userId, productId, callbackQuery.id);
} else if (data.startsWith('details_')) {
const productId = parseInt(data.replace('details_', ''));
await handleViewDetails(chatId, productId, callbackQuery.id);
}
// Answer callback query await bot.answerCallbackQuery(callbackQuery.id); 
} catch (error) {
console.error('Callback error:', error);
await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request' });
}
};
// ========== PHOTO HANDLER ========== //
const handlePhoto = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
const userState = userStates.get(userId);
if (userState && userState.state === 'awaiting_product_images') {
const photo = msg.photo[msg.photo.length - 1];
if (!userState.productData.images) { userState.productData.images = []; } userState.productData.images.push(photo.file_id); userStates.set(userId, userState); if (userState.productData.images.length === 1) { await bot.sendMessage(chatId, `✅ *First photo received!*\n\n` + `You can send more photos (max 5) or type 'next' to continue.`, { parse_mode: 'Markdown' } ); } 
}
};
// ========== VERCEL HANDLER ========== //
module.exports = async (req, res) => {
// Set CORS headers
res.setHeader('Access-Control-Allow-Credentials', true);
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
// Handle preflight requests
if (req.method === 'OPTIONS') {
return res.status(200).end();
}
// Handle GET requests (for webhook setup and health checks)
if (req.method === 'GET') {
return res.status(200).json({
status: 'online',
message: 'JU Marketplace Bot is running on Vercel!',
timestamp: new Date().toISOString(),
stats: {
users: users.size,
products: products.size
}
});
}
// Handle POST requests (Telegram webhook updates)
if (req.method === 'POST') {
try {
const update = req.body;
// Handle different update types if (update.message) { await handleMessage(update.message); } else if (update.callback_query) { await handleCallbackQuery(update.callback_query); } else if (update.message && update.message.photo) { await handlePhoto(update.message); } return res.status(200).json({ ok: true }); } catch (error) { console.error('Error processing update:', error); return res.status(500).json({ error: 'Internal server error' }); } 
}
// Method not allowed
return res.status(405).json({ error: 'Method not allowed' });
};
// ========== PLACEHOLDER FUNCTIONS ========== //
// Add these functions to complete the functionality
const handleMyProducts = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
const userProducts = Array.from(products.values())
.filter(product => product.sellerId === userId);
if (userProducts.length === 0) {
await bot.sendMessage(chatId,
📋 *My Products*\n\n +
You haven't listed any products yet.\n\n +
Start selling with "➕ Sell Item"! 💫,
{ parse_mode: 'Markdown' }
);
return;
}
let message = 📋 *Your Products (${userProducts.length})*\n\n;
userProducts.forEach((product, index) => {
const statusIcon = product.status === 'approved' ? '✅' : '⏳';
message += ${index + 1}. ${statusIcon} *${product.title}*\n;
message += 💰 ${product.price} ETB | ${product.category}\n\n;
});
await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
};
const handleContact = async (msg) => {
const chatId = msg.chat.id;
await bot.sendMessage(chatId,
📞 *Contact Administration*\n\n +
For help, issues, or suggestions:\n\n +
• Use the help command: /help\n +
• Report issues to admins\n +
• Be specific about your concern\n\n +
We'll respond as soon as possible!,
{ parse_mode: 'Markdown' }
);
};
const handleStatus = async (msg) => {
const chatId = msg.chat.id;
const totalProducts = products.size;
const approvedProducts = Array.from(products.values()).filter(p => p.status === 'approved').length;
const totalUsers = users.size;
await bot.sendMessage(chatId,
📊 *Marketplace Status*\n\n +
👥 Users: ${totalUsers}\n +
🛍️ Products: ${totalProducts}\n +
✅ Approved: ${approvedProducts}\n +
⏳ Pending: ${totalProducts - approvedProducts}\n\n +
🏪 JU Marketplace - Active and Running! 🎓,
{ parse_mode: 'Markdown' }
);
};
const handleRegularMessage = async (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id;
const text = msg.text;
const userState = userStates.get(userId);
if (userState && userState.state === 'awaiting_product_images' && text.toLowerCase() === 'next') {
userState.state = 'awaiting_product_title';
userStates.set(userId, userState);
await bot.sendMessage(chatId, `🏷️ *Step 2/5 - Product Title*\n\n` + `Enter a clear title for your item:`, { parse_mode: 'Markdown' } ); 
}
// Add more state handling as needed
};
const handleBuyProduct = async (chatId, userId, productId, callbackQueryId) => {
const product = products.get(productId);
const seller = users.get(product.sellerId);
await bot.sendMessage(chatId,
🛒 *Purchase Request Sent!*\n\n +
🏷️ *Product:* ${product.title}\n +
💰 *Price:* ${product.price} ETB\n +
👤 *Seller:* ${seller.firstName}\n\n +
Contact the seller to arrange meetup!,
{ parse_mode: 'Markdown' }
);
};
const handleContactSeller = async (chatId, userId, productId, callbackQueryId) => {
const product = products.get(productId);
const seller = users.get(product.sellerId);
await bot.sendMessage(chatId,
📞 *Seller Contact*\n\n +
👤 *Seller:* ${seller.firstName}\n +
💬 *Username:* @${seller.username || 'No username'}\n\n +
Send them a message to inquire!,
{ parse_mode: 'Markdown' }
);
};
const handleViewDetails = async (chatId, productId, callbackQueryId) => {
const product = products.get(productId);
const seller = users.get(product.sellerId);
await bot.sendMessage(chatId,
🔍 *Product Details*\n\n +
🏷️ *Title:* ${product.title}\n +
💰 *Price:* ${product.price} ETB\n +
📂 *Category:* ${product.category}\n +
👤 *Seller:* ${seller.firstName}\n\n +
${product.description ? 📝 Description:\n${product.description}\n\n : ''} +
📍 *Campus transaction recommended*,
{ parse_mode: 'Markdown' }
);
};
console.log('✅ JU Marketplace Bot configured for Vercel!');
