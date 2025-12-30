const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode"); // Biblioteca para gerar arquivo de imagem
const fs = require("fs");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    // Adicione estas linhas para garantir estabilidade no GitHub
    userDataDir: "./.wwebjs_auth/session",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

// Evento disparado quando o QR Code é gerado
client.on("qr", (qr) => {
  console.log("--- NOVO QR CODE GERADO ---");

  // Opção 1: No Terminal (ajustado para ser maior/melhor leitura)
  qrcodeTerminal.generate(qr, { small: false });

  // Opção 2: Salva em um arquivo .png para você abrir no computador
  QRCode.toFile("./qrcode.png", qr, (err) => {
    if (err) {
      console.error("Erro ao salvar o QR Code em imagem:", err);
    } else {
      console.log('SUCESSO: O QR Code foi salvo como "qrcode.png".');
      console.log("Abra este arquivo na sua pasta e escaneie com o celular.");
    }
  });
});

// Evento quando o bot conecta com sucesso
client.on("ready", () => {
  console.log("✅ Bot online e monitorando links!");
  // Apaga a imagem do QR Code após logar para manter a pasta limpa
  if (fs.existsSync("./qrcode.png")) {
    fs.unlinkSync("./qrcode.png");
  }
});

// Lógica de Moderação de Links
client.on("message", async (msg) => {
  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    try {
      const chat = await msg.getChat();

      if (chat.isGroup) {
        // Foca primeiro em apagar a mensagem
        await msg.delete(true);
        console.log("✅ Link removido com sucesso.");

        // Envia o aviso de forma simples, sem buscar o objeto Contact completo
        // Usamos o ID direto da mensagem para evitar o erro do getContact()
        const authorId = msg.author || msg.from;
        await chat.sendMessage(`⚠️ Links não são permitidos neste grupo!`);
      }
    } catch (error) {
      // Se o erro persistir, aqui filtramos para não poluir o console
      if (error.message.includes("getIsMyContact")) {
        console.log(
          "Log: Link apagado, mas houve erro ao identificar o nome do autor (Bug da biblioteca)."
        );
      } else {
        console.error("Falha técnica real:", error.message);
      }
    }
  }
});

client.initialize();
