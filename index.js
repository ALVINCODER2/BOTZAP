const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-notifications",
    ],
  },
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});

let grupoAlvoId = null;
let isShuttingDown = false; // Trava para evitar reconexão no fim do turno

client.on("qr", (qr) => {
  if (isShuttingDown) return; // Não gera QR se estiver desligando
  console.log("\n--- NOVO QR CODE GERADO ---");
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toFile("./qrcode.png", qr, (err) => {});
});

client.on("ready", () => {
  console.log("✅ Bot conectado e monitorando links!");
  if (fs.existsSync("./qrcode.png")) fs.unlinkSync("./qrcode.png");

  // --- CONFIGURAÇÃO DE TEMPO (5h 45m) ---
  // Roda o máximo possível para diminuir a janela "offline"
  const TEMPO_LIMITE = (5 * 60 + 45) * 60 * 1000;

  setTimeout(async () => {
    console.log("\n⏰ Turno de 5h 45m encerrado. Passando o bastão...");
    isShuttingDown = true; // Ativa a trava: Proíbe reconexões

    try {
      await client.destroy();
      console.log("✅ Sessão encerrada. Tchau!");
      process.exit(0);
    } catch (err) {
      process.exit(0);
    }
  }, TEMPO_LIMITE);
});

client.on("disconnected", async (reason) => {
  // SE A TRAVA ESTIVER ATIVADA, NÃO FAZ NADA (Deixa o bot morrer em paz)
  if (isShuttingDown) {
    console.log("🛑 Desconexão ignorada (Shutdown em andamento).");
    return;
  }

  console.log("❌ Bot desconectado:", reason);
  grupoAlvoId = null;

  if (reason === "LOGOUT" || reason === "NAVIGATION") {
    try {
      const sessionPath = "./.wwebjs_auth";
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    } catch (error) {}
  }

  try {
    await client.destroy();
  } catch (error) {}

  console.log("🔄 Tentando reconectar em 5 segundos...");
  setTimeout(() => {
    if (!isShuttingDown) client.initialize();
  }, 5000);
});

client.on("message", async (msg) => {
  if (isShuttingDown) return; // Não processa mensagens se estiver saindo

  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    if (msg.body.includes("damasarena.fly.dev")) return;

    if (grupoAlvoId && msg.from === grupoAlvoId) {
      try {
        await msg.delete(true);
      } catch (e) {}
      return;
    }

    try {
      const chat = await msg.getChat();
      if (chat.isGroup && chat.name === "DAMAS APOSTADO ♟️") {
        grupoAlvoId = chat.id._serialized;
        try {
          await msg.delete(true);
        } catch (delError) {}
      }
    } catch (error) {}
  }
});

console.log("Inicializando bot...");
client.initialize();
