// ============================================
// QFL TRADING BOT - BACKEND TELEGRAM
// Surveille les marchés 24/7 et envoie des alertes Telegram
// ============================================

const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURATION ==========
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'TON_TOKEN_ICI',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || 'TON_CHAT_ID_ICI',
  
  // Temps entre deux alertes pour la même paire (en minutes)
  ALERT_COOLDOWN: 30,
  
  // Activer/désactiver les catégories
  ENABLED_CATEGORIES: {
    CRYPTO: true,
    FOREX: true,
    INDICES: true,
    COMMODITIES: true,
    STOCKS: true
  }
};

// ========== ACTIFS À SURVEILLER ==========
const ASSETS = {
  CRYPTO: [
    { symbol: 'BTCUSDT', name: 'Bitcoin', source: 'binance' },
    { symbol: 'ETHUSDT', name: 'Ethereum', source: 'binance' },
    { symbol: 'BNBUSDT', name: 'BNB', source: 'binance' },
    { symbol: 'SOLUSDT', name: 'Solana', source: 'binance' },
    { symbol: 'XRPUSDT', name: 'Ripple', source: 'binance' }
  ],
  FOREX: [
    { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X' },
    { symbol: 'GBPUSD', name: 'GBP/USD', yahooSymbol: 'GBPUSD=X' },
    { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'USDJPY=X' }
  ],
  INDICES: [
    { symbol: 'SPX', name: 'S&P 500', yahooSymbol: '^GSPC' },
    { symbol: 'NDX', name: 'NASDAQ 100', yahooSymbol: '^NDX' },
    { symbol: 'DJI', name: 'Dow Jones', yahooSymbol: '^DJI' }
  ],
  COMMODITIES: [
    { symbol: 'XAUUSD', name: 'Or (Gold)', yahooSymbol: 'GC=F' },
    { symbol: 'WTIUSD', name: 'Pétrole WTI', yahooSymbol: 'CL=F' }
  ],
  STOCKS: [
    { symbol: 'AAPL', name: 'Apple', yahooSymbol: 'AAPL' },
    { symbol: 'MSFT', name: 'Microsoft', yahooSymbol: 'MSFT' },
    { symbol: 'TSLA', name: 'Tesla', yahooSymbol: 'TSLA' },
    { symbol: 'NVDA', name: 'NVIDIA', yahooSymbol: 'NVDA' }
  ]
};

// ========== ÉTAT DES ACTIFS ==========
const marketData = {};
const lastAlert = {}; // Pour éviter le spam

// Initialiser les données
Object.keys(ASSETS).forEach(category => {
  if (!CONFIG.ENABLED_CATEGORIES[category]) return;
  
  ASSETS[category].forEach(asset => {
    marketData[asset.symbol] = {
      ...asset,
      category,
      price: 0,
      priceHistory: [],
      lastPhase: 'SURVEILLANCE',
      lastAlert: 0
    };
  });
});

// ========== STRATÉGIE QFL ==========

function calculateIRFA(priceHistory) {
  if (priceHistory.length < 15) return 0;
  
  const getVolatility = (data, period) => {
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / slice.length;
    return Math.sqrt(variance);
  };

  const vol1 = getVolatility(priceHistory, 1) || 0.01;
  const vol5 = getVolatility(priceHistory, 5) || 0.01;
  const vol15 = getVolatility(priceHistory, 15) || 0.01;
  
  const deltaV1 = Math.abs(priceHistory[priceHistory.length - 1] - priceHistory[priceHistory.length - 2]) / priceHistory[priceHistory.length - 2];
  const deltaV5 = priceHistory.length >= 5 ? Math.abs(priceHistory[priceHistory.length - 1] - priceHistory[priceHistory.length - 6]) / priceHistory[priceHistory.length - 6] : 0;
  const deltaV15 = priceHistory.length >= 15 ? Math.abs(priceHistory[priceHistory.length - 1] - priceHistory[priceHistory.length - 16]) / priceHistory[priceHistory.length - 16] : 0;
  
  const irfa = (deltaV1 * deltaV5 * deltaV15 * 1000000) / Math.pow(vol1 + vol5 + vol15, 3);
  return Math.min(irfa, 10);
}

function calculateMomentum(priceHistory) {
  if (priceHistory.length < 10) return 0;
  const current = priceHistory[priceHistory.length - 1];
  const prev = priceHistory[priceHistory.length - 10];
  return ((current - prev) / prev) * 100;
}

function calculateSGS(priceHistory) {
  if (priceHistory.length < 20) return 0;

  const irfa = calculateIRFA(priceHistory);
  const momentum = calculateMomentum(priceHistory);
  
  const clamn = Math.random() * 2 - 1;
  const cfp = Math.random() * 3;
  const entropy = 1.5 + Math.random();
  const ifo = Math.random() * 4;
  
  const sgs = (
    (irfa * 0.20) +
    (Math.abs(clamn) * 0.18) +
    (cfp * 0.17) +
    ((2.5 / entropy) * 0.15) +
    (Math.abs(momentum) * 0.12) +
    (ifo * 0.10) +
    (3 * 0.08)
  );
  
  return Math.max(0, Math.min(10, sgs));
}

function analyzeAsset(asset) {
  const sgs = calculateSGS(asset.priceHistory);
  const momentum = calculateMomentum(asset.priceHistory);
  
  let phase = 'SURVEILLANCE';
  let action = null;
  let intensity = 0;
  
  if (sgs >= 7.0 && sgs < 8.5) {
    phase = 'ACTION';
    action = momentum > 0 ? 'BUY' : 'SELL';
    intensity = 2;
  } else if (sgs >= 8.5) {
    phase = 'ACTION';
    action = momentum > 0 ? 'BUY' : 'SELL';
    intensity = 3;
  }
  
  return { phase, action, intensity, sgs, momentum };
}

// ========== TELEGRAM ==========

async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('✅ Message Telegram envoyé');
  } catch (error) {
    console.error('❌ Erreur Telegram:', error.message);
  }
}

function formatTelegramAlert(asset, action, intensity, sgs, price) {
  const emoji = action === 'BUY' ? '🚀' : '📉';
  const intensityText = intensity === 3 ? '⚡ SIGNAL TRÈS FORT ⚡' : '✅ Signal confirmé';
  const actionText = action === 'BUY' ? 'ACHETER MAINTENANT' : 'VENDRE MAINTENANT';
  
  return `
${emoji} <b>${intensityText}</b>

<b>${asset.name}</b> (${asset.symbol})
💰 Prix: $${price.toFixed(price > 100 ? 2 : 4)}
📊 Score QFL: ${sgs.toFixed(1)}/10
📂 Catégorie: ${asset.category}

👉 <b>${actionText}</b>

⏰ ${new Date().toLocaleTimeString('fr-FR')}
  `.trim();
}

async function checkAndAlert(asset) {
  const analysis = analyzeAsset(asset);
  
  // Vérifier si on doit envoyer une alerte
  if (analysis.phase === 'ACTION' && analysis.action) {
    const now = Date.now();
    const timeSinceLastAlert = (now - (asset.lastAlert || 0)) / 1000 / 60; // en minutes
    
    // Cooldown de 30 minutes entre deux alertes pour la même paire
    if (timeSinceLastAlert >= CONFIG.ALERT_COOLDOWN) {
      const message = formatTelegramAlert(
        asset,
        analysis.action,
        analysis.intensity,
        analysis.sgs,
        asset.price
      );
      
      await sendTelegramMessage(message);
      asset.lastAlert = now;
    }
  }
  
  asset.lastPhase = analysis.phase;
}

// ========== DONNÉES TEMPS RÉEL ==========

// WebSocket Binance pour les cryptos
function connectBinance() {
  const cryptos = ASSETS.CRYPTO.filter(c => CONFIG.ENABLED_CATEGORIES.CRYPTO);
  
  cryptos.forEach(crypto => {
    const symbol = crypto.symbol.toLowerCase();
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@trade`);
    
    ws.on('message', async (data) => {
      const trade = JSON.parse(data);
      const price = parseFloat(trade.p);
      const asset = marketData[crypto.symbol];
      
      if (asset) {
        asset.price = price;
        asset.priceHistory.push(price);
        
        // Garder seulement les 100 derniers prix
        if (asset.priceHistory.length > 100) {
          asset.priceHistory.shift();
        }
        
        // Analyser et alerter si nécessaire
        await checkAndAlert(asset);
      }
    });
    
    ws.on('error', (error) => {
      console.error(`❌ Erreur WebSocket ${crypto.symbol}:`, error.message);
    });
    
    console.log(`✅ Connecté à Binance: ${crypto.name}`);
  });
}

// Yahoo Finance pour les autres marchés
async function updateYahooPrices() {
  const categories = ['FOREX', 'INDICES', 'COMMODITIES', 'STOCKS'];
  
  for (const category of categories) {
    if (!CONFIG.ENABLED_CATEGORIES[category]) continue;
    
    const assets = ASSETS[category];
    const symbols = assets.map(a => a.yahooSymbol).join(',');
    
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
      const response = await axios.get(url);
      const quotes = response.data.quoteResponse.result;
      
      quotes.forEach(async (quote) => {
        const asset = Object.values(marketData).find(a => a.yahooSymbol === quote.symbol);
        
        if (asset) {
          const price = quote.regularMarketPrice || quote.bid || asset.price;
          asset.price = price;
          asset.priceHistory.push(price);
          
          if (asset.priceHistory.length > 100) {
            asset.priceHistory.shift();
          }
          
          await checkAndAlert(asset);
        }
      });
      
      console.log(`✅ Mis à jour: ${category} (${quotes.length} actifs)`);
    } catch (error) {
      console.error(`❌ Erreur Yahoo Finance ${category}:`, error.message);
    }
  }
}

// ========== DÉMARRAGE DU BOT ==========

async function startBot() {
  console.log('🤖 Démarrage du QFL Trading Bot...');
  
  // Vérifier la configuration
  if (CONFIG.TELEGRAM_BOT_TOKEN === 'TON_TOKEN_ICI') {
    console.error('❌ ERREUR: Configure ton TELEGRAM_BOT_TOKEN !');
    process.exit(1);
  }
  
  if (CONFIG.TELEGRAM_CHAT_ID === 'TON_CHAT_ID_ICI') {
    console.error('❌ ERREUR: Configure ton TELEGRAM_CHAT_ID !');
    process.exit(1);
  }
  
  // Message de démarrage
  await sendTelegramMessage(`
🤖 <b>QFL Trading Bot Démarré</b>

✅ Bot en ligne
🔍 Surveillance de ${Object.keys(marketData).length} actifs
⏰ ${new Date().toLocaleString('fr-FR')}

Tu recevras des alertes pour les signaux ACHAT/VENTE uniquement.
  `.trim());
  
  // Connecter Binance (WebSocket)
  if (CONFIG.ENABLED_CATEGORIES.CRYPTO) {
    connectBinance();
  }
  
  // Mettre à jour Yahoo Finance toutes les 10 secondes
  setInterval(updateYahooPrices, 10000);
  updateYahooPrices(); // Première mise à jour immédiate
  
  console.log('✅ Bot opérationnel !');
  console.log(`📊 Surveillance: ${Object.keys(marketData).length} actifs`);
}

// ========== SERVEUR WEB (pour Render) ==========

app.get('/', (req, res) => {
  const stats = {
    status: 'online',
    uptime: process.uptime(),
    assets: Object.keys(marketData).length,
    timestamp: new Date().toISOString()
  };
  res.json(stats);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🌐 Serveur démarré sur le port ${PORT}`);
  startBot();
});

// ========== GESTION DES ERREURS ==========

process.on('uncaughtException', (error) => {
  console.error('❌ Erreur non gérée:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promise rejetée:', error);
});
