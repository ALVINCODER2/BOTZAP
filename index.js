const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");

const LOCK_FILE = "./bot.lock";

if (fs.existsSync(LOCK_FILE)) {
  const lockData = fs.readFileSync(LOCK_FILE, "utf8");
  const { pid, timestamp } = JSON.parse(lockData);
  const agora = Date.now();
  
  if (agora - timestamp < 6 * 60 * 60 * 1000) {
    console.log(`⚠️ Bot já está rodando (PID: ${pid}). Encerrando duplicata.`);
    process.exit(0);
  } else {
    console.log("🔄 Lock expirado. Removendo...");
    fs.unlinkSync(LOCK_FILE);
  }
}

fs.writeFileSync(LOCK_FILE, JSON.stringify({ 
  pid: process.pid, 
  timestamp: Date.now() 
}));

process.on("exit", () => {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {}
});

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth"
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-extensions",
      "--hide-scrollbars",
      "--disable-notifications",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

const GRUPOS_MONITORADOS = ["DAMAS APOSTADO ♟️", "Teste"];
let gruposAlvoIds = {};
let isShuttingDown = false;
let violacoesPorUsuario = {};

client.on("authenticated", () => {
  console.log("✅ Autenticação bem-sucedida!");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha na autenticação:", msg);
});

client.on("loading_screen", (percent, message) => {
  console.log(`⏳ Carregando: ${percent}% - ${message}`);
});

function resetarContagemDiaria(userId) {
  const hoje = new Date().toDateString();
  if (!violacoesPorUsuario[userId] || violacoesPorUsuario[userId].date !== hoje) {
    violacoesPorUsuario[userId] = { count: 0, date: hoje };
  }
}

function registrarViolacao(userId) {
  resetarContagemDiaria(userId);
  violacoesPorUsuario[userId].count++;
  return violacoesPorUsuario[userId].count;
}

client.on("qr", (qr) => {
  if (isShuttingDown) return;
  console.log("\n--- NOVO QR CODE GERADO ---");
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toFile("./qrcode.png", qr, (err) => {});
});

client.on("ready", () => {
  console.log("✅ Bot conectado e monitorando links!");
  if (fs.existsSync("./qrcode.png")) fs.unlinkSync("./qrcode.png");

  const TEMPO_LIMITE = (5 * 60 + 40) * 60 * 1000;

  setTimeout(async () => {
    console.log("\n⏰ Turno de 5h 40m encerrado. Passando o bastão...");
    isShuttingDown = true;

    try {
      if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
      }
      await client.destroy();
      console.log("✅ Sessão encerrada. Tchau!");
      process.exit(0);
    } catch (err) {
      process.exit(0);
    }
  }, TEMPO_LIMITE);
});

client.on("disconnected", async (reason) => {
  if (isShuttingDown) {
    console.log("🛑 Desconexão ignorada (Shutdown em andamento).");
    return;
  }

  console.log("❌ Bot desconectado:", reason);
  gruposAlvoIds = {};

  try {
    await client.destroy();
  } catch (error) {
    console.error("⚠️ Erro ao destruir cliente:", error.message);
  }

  console.log("🔄 Tentando reconectar em 5 segundos...");
  setTimeout(() => {
    if (!isShuttingDown) {
      console.log("🔄 Reinicializando cliente...");
      client.initialize();
    }
  }, 5000);
});

client.on("message", async (msg) => {
  if (isShuttingDown) return;

  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    if (msg.body.includes("damasarena.fly.dev")) return;

    try {
      const chat = await msg.getChat();
      
      if (!chat.isGroup) return;

      const isMonitorado = GRUPOS_MONITORADOS.includes(chat.name);
      if (!isMonitorado) return;

      if (!gruposAlvoIds[chat.id._serialized]) {
        gruposAlvoIds[chat.id._serialized] = chat.name;
        console.log(`📋 Grupo "${chat.name}" adicionado ao monitoramento`);
      }

      const userId = msg.author || msg.from;
      const totalViolacoes = registrarViolacao(userId);

      console.log(`🚨 Link detectado de ${userId} no grupo "${chat.name}". Violações hoje: ${totalViolacoes}/4`);

      try {
        await msg.delete(true);
        console.log("✅ Link deletado com sucesso.");
      } catch (delError) {
        console.error("❌ Erro ao deletar link:", delError.message);
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      try {
        const contact = await client.getContactById(userId);
        const nome = contact.pushname || contact.name || userId.split("@")[0];
        const mensagemAviso = `⚠️ @${userId.split("@")[0]}, link removido!\n\nAvisos hoje: ${totalViolacoes}/4` + 
          (totalViolacoes >= 4 ? `\n\n🔴 LIMITE ATINGIDO - Remoção iminente!` : "");
        
        await chat.sendMessage(chat.id._serialized, mensagemAviso);
        console.log(`✅ Aviso enviado no grupo`);
      } catch (msgError) {
        console.error("⚠️ Erro ao enviar aviso:", msgError.message);
      }

      console.log(`📢 Usuário ${userId} - Violações: ${totalViolacoes}/4`);

      if (totalViolacoes >= 4) {
        try {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await chat.removeParticipants([userId]);
          console.log(`❌ Usuário ${userId} removido após 4 violações.`);
        } catch (removeError) {
          console.error("⚠️ Erro ao remover usuário:", removeError.message);
        }
      }
    } catch (error) {
      console.error("❌ Erro ao processar mensagem:", error.message);
    }
  }
});

console.log("Inicializando bot...");
client.initialize();