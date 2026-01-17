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
  // Remove webVersionCache to use the latest version automatically
  // This prevents version mismatch issues
});

let grupoAlvoId = null;
let isShuttingDown = false; // Trava para evitar reconexão no fim do turno

// Sistema de rastreamento de links por usuário
let violacoesPorUsuario = {}; // { userId: { count: number, date: string } }

// Handlers de autenticação
client.on("authenticated", () => {
  console.log("✅ Autenticação bem-sucedida!");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha na autenticação:", msg);
  // Limpar sessão em caso de falha
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

// Função para resetar contador diário
function resetarContagemDiaria(userId) {
  const hoje = new Date().toDateString();
  if (!violacoesPorUsuario[userId] || violacoesPorUsuario[userId].date !== hoje) {
    violacoesPorUsuario[userId] = { count: 0, date: hoje };
  }
}

// Função para incrementar violações
function registrarViolacao(userId) {
  resetarContagemDiaria(userId);
  violacoesPorUsuario[userId].count++;
  return violacoesPorUsuario[userId].count;
}

client.on("qr", (qr) => {
  if (isShuttingDown) return; // Não gera QR se estiver desligando
  console.log("\n--- NOVO QR CODE GERADO ---");
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toFile("./qrcode.png", qr, (err) => {});
});

client.on("ready", () => {
  console.log("✅ Bot conectado e monitorando links!");
  if (fs.existsSync("./qrcode.png")) fs.unlinkSync("./qrcode.png");

  // --- CONFIGURAÇÃO DE TEMPO (5h 55m) ---
  // Roda o máximo possível para diminuir a janela "offline"
  const TEMPO_LIMITE = (5 * 60 + 55) * 60 * 1000;

  setTimeout(async () => {
    console.log("\n⏰ Turno de 5h 55m encerrado. Passando o bastão...");
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

  // Para LOGOUT ou NAVIGATION, limpar a sessão e aguardar mais tempo
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

    // Aguardar mais tempo antes de reconectar após LOGOUT
    console.log("🔄 Aguardando 15 segundos antes de reconectar...");
    setTimeout(() => {
      if (!isShuttingDown) {
        console.log("🔄 Reinicializando cliente...");
        client.initialize();
      }
    }, 15000);
    return;
  }

  // Para outras desconexões, tentar reconectar mais rápido
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
  if (isShuttingDown) return; // Não processa mensagens se estiver saindo

  const linkRegex =
    /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9]+\.[a-z]{2,}(\/.*)?)/gi;

  if (linkRegex.test(msg.body) && !msg.fromMe) {
    if (msg.body.includes("damasarena.fly.dev")) return;

    if (grupoAlvoId && msg.from === grupoAlvoId) {
      try {
        // Obter chat antes de deletar
        const chat = await msg.getChat();
        const userId = msg.author || msg.from;
        
        // Deletar o link
        await msg.delete(true);

        // Registrar violação e contar
        const totalViolacoes = registrarViolacao(userId);

        console.log(`🚨 Link deletado de ${userId}. Violações hoje: ${totalViolacoes}/4`);

        // Aguardar um pouco para o WhatsApp processar a exclusão
        await new Promise(resolve => setTimeout(resolve, 500));

        // Enviar mensagem de aviso diretamente ao chat
        try {
          const mensagemAviso = `@${userId.split('@')[0]} Olá, Sou Bot Exterminador! 🤖🔥\nSeu link foi detectado, neutralizado e completamente exterminado 💥🚫😈🚀\n\n⚠️ *Avisos hoje: ${totalViolacoes}/4*\n${totalViolacoes >= 4 ? "🔴 *LIMITE ATINGIDO! Você será removido do grupo.*" : ""}`;
          await chat.sendMessage(mensagemAviso, { mentions: [userId] });
          console.log(`✅ Mensagem de aviso enviada para ${userId}`);
        } catch (msgError) {
          console.error("⚠️ Erro ao enviar mensagem com menção:", msgError.message);
          // Fallback: tentar enviar sem menção
          try {
            const mensagemSimples = `Olá! Sou Bot Exterminador! 🤖🔥\nUm link foi detectado e deletado.\n\n⚠️ *Avisos hoje: ${totalViolacoes}/4*\n${totalViolacoes >= 4 ? "🔴 *LIMITE ATINGIDO!*" : ""}`;
            await chat.sendMessage(mensagemSimples);
            console.log("✅ Mensagem de aviso enviada (sem menção)");
          } catch (fallbackError) {
            console.error("❌ Erro ao enviar mensagem (fallback):", fallbackError.message);
          }
        }

        // Se atingiu 4 violações, remover do grupo
        if (totalViolacoes >= 4) {
          try {
            await chat.removeParticipants([userId]);
            console.log(`❌ Usuário ${userId} removido após 4 violações.`);
          } catch (removeError) {
            console.error("Erro ao remover usuário:", removeError.message);
          }
        }
      } catch (e) {
        console.error("Erro ao processar link:", e.message);
      }
      return;
    }

    try {
      const chat = await msg.getChat();
      if (chat.isGroup && chat.name === "DAMAS APOSTADO ♟️") {
        grupoAlvoId = chat.id._serialized;
        
        try {
          const userId = msg.author || msg.from;
          
          // Deletar o link
          await msg.delete(true);

          // Registrar violação e contar
          const totalViolacoes = registrarViolacao(userId);

          console.log(`🚨 Link deletado de ${userId}. Violações hoje: ${totalViolacoes}/4`);

          // Aguardar um pouco para o WhatsApp processar a exclusão
          await new Promise(resolve => setTimeout(resolve, 500));

          // Enviar mensagem de aviso diretamente ao chat
          try {
            const mensagemAviso = `@${userId.split('@')[0]} Olá, Sou Bot Exterminador! 🤖🔥\nSeu link foi detectado, neutralizado e completamente exterminado 💥🚫😈🚀\n\n⚠️ *Avisos hoje: ${totalViolacoes}/4*\n${totalViolacoes >= 4 ? "🔴 *LIMITE ATINGIDO! Você será removido do grupo.*" : ""}`;
            await chat.sendMessage(mensagemAviso, { mentions: [userId] });
            console.log(`✅ Mensagem de aviso enviada para ${userId}`);
          } catch (msgError) {
            console.error("⚠️ Erro ao enviar mensagem com menção:", msgError.message);
            // Fallback: tentar enviar sem menção
            try {
              const mensagemSimples = `Olá! Sou Bot Exterminador! 🤖🔥\nUm link foi detectado e deletado.\n\n⚠️ *Avisos hoje: ${totalViolacoes}/4*\n${totalViolacoes >= 4 ? "🔴 *LIMITE ATINGIDO!*" : ""}`;
              await chat.sendMessage(mensagemSimples);
              console.log("✅ Mensagem de aviso enviada (sem menção)");
            } catch (fallbackError) {
              console.error("❌ Erro ao enviar mensagem (fallback):", fallbackError.message);
            }
          }

          // Se atingiu 4 violações, remover do grupo
          if (totalViolacoes >= 4) {
            try {
              await chat.removeParticipants([userId]);
              console.log(`❌ Usuário ${userId} removido após 4 violações.`);
            } catch (removeError) {
              console.error("Erro ao remover usuário:", removeError.message);
            }
          }
        } catch (delError) {
          console.error("Erro ao deletar mensagem:", delError.message);
        }
      }
    } catch (error) {
      console.error("Erro ao obter chat:", error);
    }
  }
});

console.log("Inicializando bot...");
client.initialize();
