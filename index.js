const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");

// Configuração do Cliente
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true, // Mude para false se quiser ver o Chrome abrindo no seu PC
    // executablePath: "/usr/bin/google-chrome", // Comentado para funcionar em Windows/Mac/Linux automaticamente
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
});

// 1. Geração do QR Code
client.on("qr", (qr) => {
  console.log("\n--- NOVO QR CODE GERADO ---");
  qrcodeTerminal.generate(qr, { small: true });

  QRCode.toFile("./qrcode.png", qr, (err) => {
    if (err) console.error("Erro ao salvar arquivo QR:", err);
  });
});

// 2. Conexão realizada + GAMBIARRA DE REINÍCIO
client.on("ready", () => {
  console.log("✅ Bot conectado e monitorando links!");

  if (fs.existsSync("./qrcode.png")) fs.unlinkSync("./qrcode.png");

  // --- INÍCIO DA GAMBIARRA ---
  // Reinicia o bot a cada 6 horas (21.600.000 milissegundos)
  // Isso previne que o Chrome consuma toda a memória RAM do servidor
  const SEIS_HORAS = 6 * 60 * 60 * 1000;

  setTimeout(async () => {
    console.log(
      "\n⏰ 6 horas de operação! Iniciando reinicialização preventiva..."
    );
    try {
      // Passo 1: Fecha o navegador e desconecta
      await client.destroy();
      console.log("♻️  Sessão anterior encerrada. Liberando memória...");

      // Passo 2: Espera 5 segundos para o sistema respirar
      setTimeout(() => {
        console.log("🚀 Reiniciando o bot agora...");
        client.initialize();
      }, 5000);
    } catch (err) {
      console.error("❌ Falha ao tentar reiniciar automaticamente:", err);
      // Se der erro grave, força o fechamento do processo (se usar PM2, ele sobe de volta)
      process.exit(1);
    }
  }, SEIS_HORAS);
  // --- FIM DA GAMBIARRA ---
});

// 3. Reconexão automática em caso de queda
client.on("disconnected", (reason) => {
  console.log("❌ Bot desconectado:", reason);
  client.initialize();
});

// 4. Lógica de Moderação de Links
client.on("message", async (msg) => {
  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    try {
      const chat = await msg.getChat();

      if (chat.isGroup) {
        await msg.delete(true);
        console.log(`🚫 Link detectado e apagado em: ${chat.name}`);
        // await chat.sendMessage("⚠️ *Links não são permitidos neste grupo!*"); // Opcional: descomente se quiser avisar
      }
    } catch (error) {
      if (!error.message?.includes("getIsMyContact")) {
        console.error("Erro ao apagar link:", error.message);
      }
    }
  }
});

console.log("Inicializando bot...");
client.initialize();
