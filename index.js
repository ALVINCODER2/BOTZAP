const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");

const LOCK_FILE = path.resolve(__dirname, "bot.lock");
const QR_FILE = path.resolve(__dirname, "qrcode.png");
const WEB_CACHE_DIR = path.resolve(__dirname, ".wwebjs_cache");
const GROUP_IDS_CACHE_FILE = path.resolve(__dirname, "monitored-groups.json");
const SESSION_MAX_MS = (5 * 60 + 40) * 60 * 1000;
const READY_FALLBACK_MS = 30000;
const SETUP_FALLBACK_AFTER_AUTH_MS = 6000;
const READY_RECOVERY_DELAY_MS = 5000;
const MAX_READY_RECOVERY_ATTEMPTS = 3;
const FROM_ME_DELETE_DELAY_MS = 1200;
const VIOLATION_LIMIT = 4;
const MESSAGE_CACHE_MS = 2 * 60 * 1000;
const MESSAGE_CACHE_CLEANUP_MS = 60 * 1000;
const POLL_INTERVAL_MS = 4000;
const POLL_MESSAGES_LIMIT = 12;
const POLL_ERROR_LOG_THROTTLE_MS = 30000;

const GROUPS_MONITORED = ["DAMAS APOSTADO ♟️", "Teste"];
const ALLOWED_SNIPPETS = ["damasarena.fly.dev"];

const state = {
  setupDone: false,
  readyFired: false,
  shuttingDown: false,
  violations: new Map(),
  processedMessages: new Map(),
  sessionTimer: null,
  dedupeTimer: null,
  readyWatchdogTimer: null,
  readyRecoveryAttempts: 0,
  isRecoveringReady: false,
  monitoredGroupIds: new Set(),
  pollTimer: null,
  pollErrorLogByGroup: new Map(),
  contingencyModeLogged: false,
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
  }),
  webVersionCache: {
    type: "none",
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearWebCache() {
  try {
    if (fs.existsSync(WEB_CACHE_DIR)) {
      fs.rmSync(WEB_CACHE_DIR, { recursive: true, force: true });
      console.log("Cache web limpo: .wwebjs_cache");
    }
  } catch (err) {
    console.error(
      "Falha ao limpar cache web:",
      err && err.message ? err.message : err,
    );
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function safeReadLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;

  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function removeLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_err) {}
}

function createLockOrExit() {
  const lock = safeReadLock();
  const now = Date.now();

  if (lock && lock.pid && lock.timestamp) {
    const lockFresh = now - lock.timestamp < SESSION_MAX_MS;
    const ownerAlive = isProcessAlive(lock.pid);

    if (lockFresh && ownerAlive) {
      console.log(
        `Bot ja esta rodando (PID ${lock.pid}). Encerrando instancia duplicada.`,
      );
      process.exit(0);
    }

    console.log("Lock antigo detectado. Removendo lock invalido.");
    removeLock();
  }

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({
      pid: process.pid,
      timestamp: now,
    }),
  );
}

function refreshLockTimestamp() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const lock = safeReadLock();
    const current = lock && lock.pid ? lock.pid : process.pid;
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({
        pid: current,
        timestamp: Date.now(),
      }),
    );
  } catch (_err) {}
}

function extractMessageBody(msg) {
  if (!msg || typeof msg.body !== "string") return "";
  return msg.body.trim();
}

function containsLink(body) {
  if (!body) return false;
  const linkRegex =
    /\b((https?:\/\/|www\.)[^\s]+|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:\/[^\s]*)?)/i;
  return linkRegex.test(body);
}

function isAllowedLink(body) {
  return ALLOWED_SNIPPETS.some((allowed) =>
    body.toLowerCase().includes(allowed.toLowerCase()),
  );
}

function resetDailyViolationsIfNeeded(userId) {
  const today = new Date().toDateString();
  const current = state.violations.get(userId);

  if (!current || current.date !== today) {
    state.violations.set(userId, { count: 0, date: today });
  }
}

function registerViolation(userId) {
  resetDailyViolationsIfNeeded(userId);
  const current = state.violations.get(userId);
  current.count += 1;
  state.violations.set(userId, current);
  return current.count;
}

function getMessageKey(msg, source) {
  const serialized =
    msg && msg.id && msg.id._serialized ? msg.id._serialized : null;
  if (serialized) return serialized;
  const from = msg && msg.from ? msg.from : "unknown";
  const ts = msg && msg.timestamp ? msg.timestamp : Date.now();
  const body = extractMessageBody(msg).slice(0, 80);
  return `${source}:${from}:${ts}:${body}`;
}

function markMessageProcessed(messageKey) {
  state.processedMessages.set(messageKey, Date.now());
}

function wasMessageProcessedRecently(messageKey) {
  const seenAt = state.processedMessages.get(messageKey);
  if (!seenAt) return false;
  return Date.now() - seenAt < MESSAGE_CACHE_MS;
}

function startDedupeCleanupLoop() {
  if (state.dedupeTimer) return;
  state.dedupeTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, seenAt] of state.processedMessages.entries()) {
      if (now - seenAt > MESSAGE_CACHE_MS) {
        state.processedMessages.delete(key);
      }
    }
    refreshLockTimestamp();
  }, MESSAGE_CACHE_CLEANUP_MS);
}

function stopDedupeCleanupLoop() {
  if (!state.dedupeTimer) return;
  clearInterval(state.dedupeTimer);
  state.dedupeTimer = null;
}

async function safeGetChats(retries = 20, delayMs = 3000) {
  let lastErr;

  for (let i = 1; i <= retries; i += 1) {
    try {
      return await client.getChats();
    } catch (err) {
      lastErr = err;
      const errText = `${err && err.message ? err.message : err}`;
      console.log(
        `safeGetChats tentativa ${i}/${retries} falhou: ${errText}`,
      );

      // Em algumas versoes do WA Web, esse erro indica contexto parcial/injetado.
      // Evita ficar preso em muitas tentativas iguais.
      if (errText.includes("reading 'update'")) {
        break;
      }
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

function saveMonitoredGroupIds(groupIds) {
  try {
    const data = {
      updatedAt: new Date().toISOString(),
      groupIds: Array.from(groupIds),
    };
    fs.writeFileSync(GROUP_IDS_CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (_err) {}
}

function loadMonitoredGroupIds() {
  try {
    if (!fs.existsSync(GROUP_IDS_CACHE_FILE)) return new Set();
    const raw = fs.readFileSync(GROUP_IDS_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groupIds)) return new Set();
    return new Set(parsed.groupIds.filter((id) => typeof id === "string" && id));
  } catch (_err) {
    return new Set();
  }
}

async function executeSetup() {
  if (state.setupDone) return;
  state.setupDone = true;

  console.log("Executando setup do bot...");

  try {
    const chats = await safeGetChats(6, 2000);
    const groups = chats.filter((chat) => chat.isGroup);
    const monitored = groups.filter((group) =>
      GROUPS_MONITORED.includes(group.name),
    );
    state.monitoredGroupIds = new Set(
      monitored.map((group) => group.id._serialized),
    );
    saveMonitoredGroupIds(state.monitoredGroupIds);

    console.log(`Total de grupos encontrados: ${groups.length}`);
    console.log(
      `Grupos monitorados encontrados: ${monitored.map((g) => g.name).join(", ") || "(nenhum)"}`,
    );
  } catch (err) {
    console.error(
      "Erro ao listar grupos:",
      err && err.message ? err.message : err,
    );

    const cachedIds = loadMonitoredGroupIds();
    if (cachedIds.size > 0) {
      state.monitoredGroupIds = cachedIds;
      console.log(
        `Usando cache local de grupos monitorados (${cachedIds.size}) devido a falha do getChats.`,
      );
    } else {
      console.log(
        "Sem cache local de grupos monitorados. O polling ficara inativo ate conseguir mapear grupos.",
      );
    }
  }

  if (fs.existsSync(QR_FILE)) {
    try {
      fs.unlinkSync(QR_FILE);
    } catch (_err) {}
  }

  startPollingLoop();

  state.sessionTimer = setTimeout(async () => {
    console.log("Turno encerrado. Desligando bot de forma segura...");
    await shutdown(0);
  }, SESSION_MAX_MS);
}

function stopPollingLoop() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollMonitoredGroups() {
  if (state.shuttingDown) return;
  if (!state.monitoredGroupIds.size) return;

  for (const groupId of state.monitoredGroupIds) {
    try {
      const chat = await client.getChatById(groupId);
      const messages = await chat.fetchMessages({ limit: POLL_MESSAGES_LIMIT });
      for (const msg of messages) {
        await processModeration(msg, "poll");
      }
    } catch (err) {
      const now = Date.now();
      const lastLog = state.pollErrorLogByGroup.get(groupId) || 0;
      if (now - lastLog >= POLL_ERROR_LOG_THROTTLE_MS) {
        state.pollErrorLogByGroup.set(groupId, now);
        console.error(
          `Falha no polling do grupo ${groupId}:`,
          err && err.message ? err.message : err,
        );
      }
    }
  }
}

function startPollingLoop() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    await pollMonitoredGroups();
  }, POLL_INTERVAL_MS);
  console.log(
    `Polling de contingencia ativo a cada ${POLL_INTERVAL_MS / 1000}s.`,
  );
}

function clearReadyWatchdog() {
  if (!state.readyWatchdogTimer) return;
  clearTimeout(state.readyWatchdogTimer);
  state.readyWatchdogTimer = null;
}

function scheduleReadyWatchdog() {
  clearReadyWatchdog();

  state.readyWatchdogTimer = setTimeout(async () => {
    if (state.readyFired || state.shuttingDown) return;

    let currentState = "UNKNOWN";
    try {
      currentState = await client.getState();
    } catch (_err) {}

    console.log(
      `Ready nao disparou em ${READY_FALLBACK_MS / 1000}s. Estado atual: ${currentState}.`,
    );

    // Se o setup de contingencia ja esta rodando e o estado e CONNECTED,
    // mantemos o bot em modo polling sem reinicializar o browser.
    if (state.setupDone && currentState === "CONNECTED") {
      if (!state.contingencyModeLogged) {
        console.log(
          "Mantendo modo contingencia (polling) sem reinicializar, para evitar detached frame.",
        );
        state.contingencyModeLogged = true;
      }
      scheduleReadyWatchdog();
      return;
    }

    if (state.readyRecoveryAttempts >= MAX_READY_RECOVERY_ATTEMPTS) {
      console.error(
        "Nao foi possivel recuperar sessao sem evento ready. Reinicie e atualize whatsapp-web.js.",
      );
      await shutdown(1);
      return;
    }

    state.readyRecoveryAttempts += 1;
    state.isRecoveringReady = true;
    stopPollingLoop();

    if (currentState === "CONNECTED") {
      clearWebCache();
    }

    try {
      await client.destroy();
    } catch (_err) {}

    await sleep(READY_RECOVERY_DELAY_MS);

    state.setupDone = false;
    state.readyFired = false;

    try {
      client.initialize();
      console.log(
        `Tentativa de recuperacao do ready ${state.readyRecoveryAttempts}/${MAX_READY_RECOVERY_ATTEMPTS}.`,
      );
    } catch (err) {
      console.error(
        "Falha ao reinicializar durante recuperacao:",
        err.message || err,
      );
      await shutdown(1);
    } finally {
      state.isRecoveringReady = false;
    }
  }, READY_FALLBACK_MS);
}

async function canDeleteOthersInGroup(chat) {
  const me =
    client.info && client.info.wid ? client.info.wid._serialized : null;
  if (!me) return false;
  if (!chat || !Array.isArray(chat.participants)) return false;

  const botParticipant = chat.participants.find(
    (p) => p && p.id && p.id._serialized === me,
  );

  return Boolean(
    botParticipant && (botParticipant.isAdmin || botParticipant.isSuperAdmin),
  );
}

async function sendWarning(chatId, count, limit) {
  const warningText = `Link removido pelo Bot.\nViolacoes hoje: ${count}/${limit}`;
  const options = { linkPreview: false, sendSeen: false };

  const attempts = [
    {
      mode: "chat.sendMessage",
      fn: async () => {
        const chat = await client.getChatById(chatId);
        await chat.sendMessage(warningText, options);
      },
    },
    {
      mode: "client.sendMessage",
      fn: async () => {
        await client.sendMessage(chatId, warningText, options);
      },
    },
    {
      mode: "chat.sendMessage(refresh)",
      fn: async () => {
        // Tenta novamente apos nova busca do chat para reduzir erro de contexto antigo.
        const refreshed = await client.getChatById(chatId);
        await refreshed.sendMessage(warningText, options);
      },
    },
  ];

  for (let i = 0; i < attempts.length; i += 1) {
    const attemptNo = i + 1;
    const attempt = attempts[i];
    try {
      await sleep(500 * attemptNo);
      await attempt.fn();
      console.log(`Aviso de moderacao enviado com sucesso (${attempt.mode}).`);
      return true;
    } catch (err) {
      console.log(
        `Falha ao enviar aviso (${attempt.mode}, tentativa ${attemptNo}): ${err && err.message ? err.message : err}`,
      );
    }
  }

  return false;
}

async function removeUserIfNeeded(
  chatId,
  userId,
  count,
  isFromMe,
  botCanDeleteOthers,
) {
  if (count < VIOLATION_LIMIT) return;
  if (isFromMe) return;
  if (!botCanDeleteOthers) return;

  try {
    const chat = await client.getChatById(chatId);
    await chat.removeParticipants([userId]);
    console.log(`Usuario removido por excesso de violacoes: ${userId}`);
  } catch (err) {
    console.error(
      `Falha ao remover usuario ${userId}:`,
      err && err.message ? err.message : err,
    );
  }
}

async function processModeration(msg, source) {
  if (state.shuttingDown) return;
  if (!msg) return;

  const body = extractMessageBody(msg);
  if (!body) return;

  const messageKey = getMessageKey(msg, source);
  if (wasMessageProcessedRecently(messageKey)) return;
  markMessageProcessed(messageKey);

  if (!containsLink(body)) return;
  if (isAllowedLink(body)) {
    return;
  }

  let chat;
  try {
    chat = await msg.getChat();
  } catch (err) {
    console.error("Falha ao obter chat da mensagem:", err.message || err);
    return;
  }

  if (!chat || !chat.isGroup) return;
  if (!GROUPS_MONITORED.includes(chat.name)) return;

  const userId = msg.author || msg.from;
  const count = registerViolation(userId);
  const chatId = chat.id._serialized;

  console.log(
    `Link detectado no grupo "${chat.name}" por ${userId}. Violacoes hoje: ${count}/${VIOLATION_LIMIT}`,
  );

  const fromMe = Boolean(msg.fromMe);
  const botCanDeleteOthers = fromMe ? true : await canDeleteOthersInGroup(chat);

  if (!fromMe && !botCanDeleteOthers) {
    console.log(
      "Bot nao e admin no grupo. Sem permissao para deletar mensagens de terceiros.",
    );
    return;
  }

  try {
    if (fromMe) {
      await sleep(FROM_ME_DELETE_DELAY_MS);
    }

    await msg.delete(true);
    console.log("Mensagem com link foi deletada com sucesso.");
  } catch (err) {
    console.error(
      "Erro ao deletar mensagem:",
      err && err.message ? err.message : err,
    );
    return;
  }

  const warningSent = await sendWarning(chatId, count, VIOLATION_LIMIT);
  if (!warningSent) {
    console.log("Falha ao enviar aviso de moderacao.");
  }

  await removeUserIfNeeded(chatId, userId, count, fromMe, botCanDeleteOthers);
}

async function shutdown(exitCode = 0) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
  }

  stopPollingLoop();
  stopDedupeCleanupLoop();
  removeLock();

  try {
    await client.destroy();
  } catch (_err) {}

  process.exit(exitCode);
}

client.on("qr", (qr) => {
  if (state.shuttingDown) return;
  console.log("Novo QR code gerado.");
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toFile(QR_FILE, qr, () => {});
});

client.on("loading_screen", (percent, message) => {
  console.log(`Carregando WhatsApp Web: ${percent}% - ${message}`);
});

client.on("authenticated", () => {
  console.log("Autenticacao bem-sucedida.");
  state.contingencyModeLogged = false;

  setTimeout(async () => {
    if (state.shuttingDown || state.setupDone) return;
    console.log(
      `Ready ainda nao disparou apos ${SETUP_FALLBACK_AFTER_AUTH_MS / 1000}s. Iniciando setup de contingencia.`,
    );
    await executeSetup();
  }, SETUP_FALLBACK_AFTER_AUTH_MS);

  scheduleReadyWatchdog();
});

client.on("auth_failure", (msg) => {
  console.error("Falha de autenticacao:", msg);
});

client.on("ready", async () => {
  clearReadyWatchdog();
  state.readyFired = true;
  state.readyRecoveryAttempts = 0;
  console.log("Evento ready disparado.");
  await executeSetup();
});

client.on("change_state", (waState) => {
  console.log(`Estado do WhatsApp: ${waState}`);
});

client.on("disconnected", async (reason) => {
  if (state.shuttingDown) return;

  clearReadyWatchdog();

  console.log(`Bot desconectado. Motivo: ${reason}`);
  if (state.isRecoveringReady) {
    console.log("Desconexao durante rotina de recuperacao do ready.");
    return;
  }
  if (reason === "LOGOUT") {
    console.log("Sessao deslogada. Encerrando para exigir novo login.");
    await shutdown(1);
    return;
  }

  try {
    await client.destroy();
  } catch (_err) {}

  console.log("Tentando reconectar em 5 segundos...");
  await sleep(5000);

  if (!state.shuttingDown) {
    try {
      client.initialize();
    } catch (err) {
      console.error("Falha ao reinicializar cliente:", err.message || err);
      await shutdown(1);
    }
  }
});

client.on("message", async (msg) => {
  await processModeration(msg, "message");
});

client.on("message_create", async (msg) => {
  await processModeration(msg, "message_create");
});

process.on("SIGINT", async () => {
  console.log("SIGINT recebido. Encerrando...");
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM recebido. Encerrando...");
  await shutdown(0);
});

process.on("uncaughtException", async (err) => {
  console.error("Erro nao tratado:", err && err.stack ? err.stack : err);
  await shutdown(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("Promise rejeitada sem tratamento:", reason);
  await shutdown(1);
});

createLockOrExit();
startDedupeCleanupLoop();
console.log("Inicializando bot...");
console.log(
  "Listeners: qr, loading_screen, authenticated, auth_failure, ready, disconnected, message, message_create",
);
client.initialize();
