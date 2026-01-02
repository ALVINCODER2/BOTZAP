const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");

// Configuração do Cliente
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
      "--hide-scrollbars",
      "--disable-notifications",
    ],
  },
  // Configuração para estabilizar a versão do WhatsApp Web
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});

// Variável para guardar o ID do grupo na memória e acelerar a exclusão
let grupoAlvoId = null;

// 1. Geração do QR Code
client.on("qr", (qr) => {
  console.log("\n--- NOVO QR CODE GERADO ---");
  qrcodeTerminal.generate(qr, { small: true });

  QRCode.toFile("./qrcode.png", qr, (err) => {
    if (err) console.error("Erro ao salvar arquivo QR:", err);
  });
});

// 2. Conexão realizada
client.on("ready", () => {
  console.log("✅ Bot conectado e monitorando links!");

  if (fs.existsSync("./qrcode.png")) fs.unlinkSync("./qrcode.png");

  // Reinicia a cada 6 horas
  const SEIS_HORAS = 6 * 60 * 60 * 1000;
  setTimeout(async () => {
    console.log("\n⏰ 6 horas de operação! Reiniciando...");
    try {
      await client.destroy();
      setTimeout(() => {
        console.log("🚀 Reiniciando agora...");
        client.initialize();
      }, 5000);
    } catch (err) {
      console.error("❌ Erro no reinício:", err);
      process.exit(1);
    }
  }, SEIS_HORAS);
});

// 3. Reconexão automática (CORRIGIDA)
client.on("disconnected", async (reason) => {
  console.log("❌ Bot desconectado:", reason);
  grupoAlvoId = null; // Limpa a memória se cair

  // CORREÇÃO CRÍTICA: Destrói o navegador antigo antes de criar um novo
  // Isso evita o erro "window['onQRChangedEvent'] already exists"
  try {
    await client.destroy();
  } catch (error) {
    console.log(
      "Aviso: Erro ao tentar destruir cliente (pode já estar fechado)."
    );
  }

  // Espera um pouco antes de tentar conectar de novo
  setTimeout(() => {
    client.initialize();
  }, 5000);
});

// 4. Lógica de Moderação OTIMIZADA
client.on("message", async (msg) => {
  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    // 🛡️ Whitelist
    if (msg.body.includes("damasarena.fly.dev")) {
      return;
    }

    // --- CAMINHO RÁPIDO ---
    if (grupoAlvoId && msg.from === grupoAlvoId) {
      try {
        await msg.delete(true);
      } catch (e) {
        console.error("Erro ao apagar rápido:", e.message);
      }
      return;
    }

    // --- CAMINHO LENTO ---
    try {
      const chat = await msg.getChat();

      if (chat.isGroup && chat.name === "DAMAS APOSTADO ♟️") {
        grupoAlvoId = chat.id._serialized;
        console.log(`🎯 Grupo identificado e salvo na memória: ${grupoAlvoId}`);

        try {
          await msg.delete(true);
          console.log(`🚫 Link apagado em: ${chat.name}`);
        } catch (delError) {
          console.error(
            `⚠️ ERRO: O Bot precisa ser ADMIN para apagar mensagens.`
          );
        }
      }
    } catch (error) {
      if (!error.message?.includes("getIsMyContact")) {
        console.error("Erro técnico:", error.message);
      }
    }
  }
});

console.log("Inicializando bot...");
client.initialize();
