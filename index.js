const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");

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

let grupoAlvoId = null;
let isShuttingDown = false;
let violacoesPorUsuario = {};

client.on("authenticated", () => {
  console.log("✅ Autenticação bem-sucedida!");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha na autenticação:", msg);
  try {
    const sessionPath = "./.wwebjs_auth";
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🗑️ Sessão corrompida removida");
    }
  } catch (error) {
    console.error("⚠️ Erro ao limpar sessão:", error.message);
  }
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
  grupoAlvoId = null;

  if (reason === "LOGOUT" || reason === "NAVIGATION") {
    console.log("🗑️ Limpando sessão devido a:", reason);
    try {
      const sessionPath = "./.wwebjs_auth";
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log("✅ Sessão removida com sucesso");
      }
    } catch (error) {
      console.error("⚠️ Erro ao limpar sessão:", error.message);
    }

    try {
      await client.destroy();
      console.log("✅ Cliente destruído");
    } catch (error) {
      console.error("⚠️ Erro ao destruir cliente:", error.message);
    }

    console.log("🔄 Aguardando 15 segundos antes de reconectar...");
    setTimeout(() => {
      if (!isShuttingDown) {
        console.log("🔄 Reinicializando cliente...");
        client.initialize();
      }
    }, 15000);
    return;
  }

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

    if (grupoAlvoId && msg.from === grupoAlvoId) {
      try {
        const chat = await msg.getChat();
        const userId = msg.author || msg.from;
        const totalViolacoes = registrarViolacao(userId);

        console.log(`🚨 Link detectado de ${userId}. Violações hoje: ${totalViolacoes}/4`);

        // 1. DELETAR O LINK IMEDIATAMENTE
        try {
          await msg.delete(true);
          console.log("✅ Link deletado com sucesso.");
        } catch (delError) {
          console.error("❌ Erro ao deletar link:", delError.message);
        }

        // 2. LOG do aviso (mensagem no console)
        console.log(`📢 AVISO: Usuário ${userId} - Violações: ${totalViolacoes}/4`);
        if (totalViolacoes >= 4) {
          console.log(`🔴 ATENÇÃO: Usuário atingiu limite - será removido!`);
        }

        // 3. Remover do grupo se necessário
        if (totalViolacoes >= 4) {
          try {
            await new Promise(resolve => setTimeout(resolve, 2000));
            await chat.removeParticipants([userId]);
            console.log(`❌ Usuário ${userId} removido após 4 violações.`);
          } catch (removeError) {
            console.error("⚠️ Erro ao remover usuário:", removeError.message);
          }
        }
      } catch (e) {
        console.error("❌ Erro ao processar link:", e.message);
      }
      return;
    }

    try {
      const chat = await msg.getChat();
      if (chat.isGroup && chat.name === "DAMAS APOSTADO ♟️") {
        grupoAlvoId = chat.id._serialized;
        
        try {
          const userId = msg.author || msg.from;
          const totalViolacoes = registrarViolacao(userId);

          console.log(`🚨 Link detectado de ${userId}. Violações hoje: ${totalViolacoes}/4`);

          // 1. DELETAR O LINK IMEDIATAMENTE
          try {
            await msg.delete(true);
            console.log("✅ Link deletado com sucesso.");
          } catch (delError) {
            console.error("❌ Erro ao deletar mensagem:", delError.message);
          }

          // 2. LOG do aviso (mensagem no console)
          console.log(`📢 AVISO: Usuário ${userId} - Violações: ${totalViolacoes}/4`);
          if (totalViolacoes >= 4) {
            console.log(`🔴 ATENÇÃO: Usuário atingiu limite - será removido!`);
          }

          // 3. Remover se necessário
          if (totalViolacoes >= 4) {
            try {
              await new Promise(resolve => setTimeout(resolve, 2000));
              await chat.removeParticipants([userId]);
              console.log(`❌ Usuário ${userId} removido após 4 violações.`);
            } catch (removeError) {
              console.error("⚠️ Erro ao remover usuário:", removeError.message);
            }
          }
        } catch (delError) {
          console.error("❌ Erro ao processar:", delError.message);
        }
      }
    } catch (error) {
      console.error("❌ Erro ao obter chat:", error);
    }
  }
});

console.log("Inicializando bot...");
client.initialize();