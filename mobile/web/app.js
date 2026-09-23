// Codex Mobile — the phone side.
//
// Talks to the bridge (mobile/bridge/codex_mobile.py), never to the internet.
// All requests carry the pairing token in the Authorization header; the event
// stream is read with fetch() for the same reason (EventSource cannot send
// headers).
"use strict";

(function () {
  const TOKEN_KEY = "codex-mobile.token";
  const THREAD_KEY = "codex-mobile.thread";

  const $ = (id) => document.getElementById(id);

  const state = {
    token: null,
    account: null,
    requiresAuth: true,
    workspace: "",
    threads: [],
    threadId: null,
    threadCwd: "",
    activeTurnId: null,
    items: new Map(), // itemId -> { item, el, text }
    pendingUserMessages: new Map(), // clientUserMessageId -> element
    approvals: new Map(), // JSON(id) -> { message, el }
    loginId: null,
    view: null,
    streamAbort: null,
    streamConnected: false,
    security: null,
  };

  // ------------------------------------------------------------------
  // Bridge API
  // ------------------------------------------------------------------

  class BridgeError extends Error {
    constructor(message, code, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: Object.assign(
        { Authorization: "Bearer " + state.token },
        body === undefined ? {} : { "Content-Type": "application/json" },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new BridgeError(
        (payload && payload.error && payload.error.message) || "not paired",
        -32001,
        response.status,
      );
    }
    if (!payload)
      throw new BridgeError(
        "bridge answered with HTTP " + response.status,
        -32000,
        response.status,
      );
    if (payload.error)
      throw new BridgeError(
        payload.error.message,
        payload.error.code,
        response.status,
      );
    return payload.result !== undefined ? payload.result : payload;
  }

  function rpc(method, params) {
    return api("/api/rpc", {
      method: method,
      params: params === undefined ? {} : params,
    });
  }

  // ------------------------------------------------------------------
  // Event stream
  // ------------------------------------------------------------------

  async function connectEvents() {
    let delay = 1000;
    let first = true;
    for (;;) {
      if (!state.token) return;
      const controller = new AbortController();
      state.streamAbort = controller;
      setConnection("connecting");
      try {
        const response = await fetch("/api/events", {
          headers: { Authorization: "Bearer " + state.token },
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401 || response.status === 403) {
          unpair("The pairing token was not accepted.");
          return;
        }
        if (!response.ok || !response.body)
          throw new Error("HTTP " + response.status);
        state.streamConnected = true;
        setConnection("online");
        delay = 1000;
        // Anything may have happened while the stream was down.
        if (!first) resync();
        first = false;
        await readStream(response.body);
      } catch (error) {
        if (controller.signal.aborted) return;
      }
      state.streamConnected = false;
      setConnection("offline");
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }

  async function readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let message;
        try {
          message = JSON.parse(data);
        } catch (_) {
          continue;
        }
        try {
          handleMessage(message);
        } catch (error) {
          console.error("failed to handle", message, error);
        }
      }
    }
  }

  function setConnection(value) {
    const dot = $("connection");
    dot.dataset.state = value;
    dot.setAttribute("aria-label", value);
  }

  // ------------------------------------------------------------------
  // Messages from Codex
  // ------------------------------------------------------------------

  function handleMessage(message) {
    const method = message.method;
    const params = message.params || {};

    // Server requests carry an id: approvals.
    if (message.id !== undefined && method) {
      addApproval(message);
      return;
    }

    switch (method) {
      case "bridge/status":
        if (params.codex !== "ready") {
          setConnection(params.codex === "starting" ? "connecting" : "offline");
          if (params.error)
            toast("Codex: " + params.codex + " — " + params.error);
        } else if (state.streamConnected) {
          setConnection("online");
        }
        return;
      case "bridge/notice":
        toast(params.text);
        return;
      case "bridge/requestAnswered":
      case "serverRequest/resolved":
        removeApproval(params.requestId);
        return;
      case "bridge/security/progress":
        securityProgress(params);
        return;
      case "bridge/security/completed":
        securityCompleted(params);
        return;
      case "account/login/completed":
        onLoginCompleted(params);
        return;
      case "account/updated":
        refreshAccount();
        return;
      case "thread/started":
      case "thread/name/updated":
      case "thread/archived":
        if (
          method === "thread/name/updated" &&
          params.threadId === state.threadId
        ) {
          setTitle(params.threadName);
        }
        loadThreads();
        return;
    }

    // Everything below belongs to one thread.
    if (params.threadId && params.threadId !== state.threadId) return;

    switch (method) {
      case "turn/started":
        setActiveTurn(params.turn && params.turn.id);
        return;
      case "turn/completed": {
        const turn = params.turn || {};
        setActiveTurn(null);
        if (turn.status === "failed" && turn.error)
          notice(turn.error.message || "The turn failed.", true);
        if (turn.status === "interrupted") notice("Stopped.");
        finishStreaming();
        loadThreads();
        return;
      }
      case "item/started":
      case "item/completed":
        upsertItem(params.item, method === "item/completed");
        return;
      case "item/agentMessage/delta":
        appendAgentDelta(params.itemId, params.delta);
        return;
      case "item/commandExecution/outputDelta":
        appendCommandOutput(params.itemId, params.delta);
        return;
      case "item/reasoning/summaryTextDelta":
        appendReasoning(params.itemId, params.delta);
        return;
      case "error":
        if (params.error)
          notice(
            params.error.message + (params.willRetry ? " (retrying)" : ""),
            !params.willRetry,
          );
        return;
    }
  }

  // ------------------------------------------------------------------
  // Conversation rendering
  // ------------------------------------------------------------------

  const messagesEl = () => $("messages");

  function isNearBottom() {
    const el = messagesEl();
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom(force) {
    const el = messagesEl();
    if (force || isNearBottom()) el.scrollTop = el.scrollHeight;
  }

  function clearConversation() {
    const el = messagesEl();
    Array.from(el.children).forEach((child) => {
      if (child.id !== "empty-state") child.remove();
    });
    state.items.clear();
    state.pendingUserMessages.clear();
    updateEmptyState();
  }

  function updateEmptyState() {
    const hasContent = messagesEl().children.length > 1;
    $("empty-state").hidden = hasContent;
    $("empty-workspace").textContent = state.threadCwd || state.workspace;
  }

  function append(el) {
    const stick = isNearBottom();
    messagesEl().appendChild(el);
    updateEmptyState();
    if (stick) scrollToBottom(true);
  }

  function notice(text, isError) {
    const el = document.createElement("div");
    el.className = "notice" + (isError ? " error" : "");
    el.textContent = text;
    append(el);
  }

  function userText(item) {
    return (item.content || [])
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image" || part.type === "localImage")
          return "[image]";
        if (part.type === "mention" || part.type === "skill")
          return "@" + part.name;
        return "";
      })
      .join("\n")
      .trim();
  }

  function upsertItem(item, completed) {
    if (!item || !item.id) return;
    const existing = state.items.get(item.id);

    if (item.type === "userMessage") {
      // Our own optimistic bubble becomes the real one.
      const pending =
        item.clientId && state.pendingUserMessages.get(item.clientId);
      if (pending) {
        pending.classList.remove("pending");
        state.pendingUserMessages.delete(item.clientId);
        state.items.set(item.id, { item: item, el: pending });
        return;
      }
      if (existing) return;
      const el = document.createElement("div");
      el.className = "msg user";
      el.textContent = userText(item);
      state.items.set(item.id, { item: item, el: el });
      append(el);
      return;
    }

    if (item.type === "agentMessage") {
      let entry = existing;
      if (!entry) {
        const el = document.createElement("div");
        el.className = "msg agent";
        entry = { item: item, el: el, text: "" };
        state.items.set(item.id, entry);
        append(el);
      }
      if (
        typeof item.text === "string" &&
        (completed || item.text.length >= entry.text.length)
      ) {
        entry.text = item.text;
      }
      entry.el.classList.toggle("streaming", !completed);
      renderAgent(entry);
      return;
    }

    if (item.type === "reasoning") {
      const summary = (item.summary || []).join("\n\n");
      let entry = existing;
      if (!entry) {
        const el = activity("Thinking", "", null);
        entry = { item: item, el: el, text: "" };
        state.items.set(item.id, entry);
        append(el);
      }
      if (summary) entry.text = summary;
      setActivityBody(entry.el, entry.text, "reasoning");
      entry.el.querySelector(".label").textContent =
        firstLine(entry.text) || "Thinking";
      return;
    }

    let entry = existing;
    const kind = describe(item);
    if (!entry) {
      entry = {
        item: item,
        el: activity(kind.kind, kind.label, item.status),
        text: "",
      };
      state.items.set(item.id, entry);
      append(entry.el);
    }
    entry.item = item;
    entry.el.querySelector(".label").textContent = kind.label;
    setStatus(entry.el, item.status);

    if (item.type === "commandExecution") {
      if (typeof item.aggregatedOutput === "string")
        entry.text = item.aggregatedOutput;
      let body = entry.text;
      if (completed && item.exitCode !== undefined && item.exitCode !== null) {
        body +=
          (body && !body.endsWith("\n") ? "\n" : "") +
          "exit code " +
          item.exitCode;
      }
      setActivityBody(
        entry.el,
        body || (completed ? "(no output)" : ""),
        "output",
      );
    } else if (item.type === "fileChange") {
      setDiffBody(entry.el, item.changes || []);
    } else if (item.type === "plan") {
      setActivityBody(entry.el, item.text || "", "plan");
    } else if (item.type === "mcpToolCall" && item.error) {
      setActivityBody(
        entry.el,
        item.error.message || JSON.stringify(item.error),
        "output",
      );
    }
  }

  function describe(item) {
    switch (item.type) {
      case "commandExecution":
        return { kind: "Run", label: item.command || "command" };
      case "fileChange": {
        const changes = item.changes || [];
        const names = changes.map((change) => change.path.split("/").pop());
        return { kind: "Edit", label: names.join(", ") || "files" };
      }
      case "mcpToolCall":
        return { kind: "Tool", label: item.server + " · " + item.tool };
      case "dynamicToolCall":
        return { kind: "Tool", label: item.tool };
      case "webSearch":
        return { kind: "Search", label: item.query || "web" };
      case "plan":
        return { kind: "Plan", label: firstLine(item.text) || "plan" };
      case "imageView":
        return { kind: "Image", label: item.path };
      case "imageGeneration":
        return { kind: "Image", label: "generated image" };
      case "contextCompaction":
        return { kind: "Context", label: "conversation compacted" };
      case "enteredReviewMode":
      case "exitedReviewMode":
        return { kind: "Review", label: item.review || "review" };
      default:
        return { kind: "Step", label: item.type };
    }
  }

  function activity(kind, label, status) {
    const details = document.createElement("details");
    details.className = "activity msg";
    const summary = document.createElement("summary");
    summary.className = "row";
    const kindEl = document.createElement("span");
    kindEl.className = "kind";
    kindEl.textContent = kind;
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    const statusEl = document.createElement("span");
    statusEl.className = "status";
    summary.append(kindEl, labelEl, statusEl);
    details.appendChild(summary);
    setStatus(details, status);
    return details;
  }

  function setStatus(el, status) {
    const statusEl = el.querySelector(".status");
    if (!statusEl) return;
    statusEl.hidden = !status;
    statusEl.dataset.status = status || "";
    statusEl.textContent =
      {
        inProgress: "running",
        completed: "done",
        failed: "failed",
        declined: "declined",
      }[status] ||
      status ||
      "";
  }

  function ensureBody(el) {
    let body = el.querySelector(".body");
    if (!body) {
      body = document.createElement("div");
      body.className = "body";
      el.appendChild(body);
    }
    return body;
  }

  function setActivityBody(el, text, variant) {
    if (!text) return;
    const body = ensureBody(el);
    let pre = body.querySelector("pre");
    if (!pre) {
      body.textContent = "";
      pre = document.createElement("pre");
      if (variant === "reasoning") pre.className = "reasoning";
      body.appendChild(pre);
    }
    pre.textContent = text;
  }

  function setDiffBody(el, changes) {
    const body = ensureBody(el);
    body.textContent = "";
    changes.forEach((change) => {
      const title = document.createElement("p");
      title.className = "mono small";
      const kind = (change.kind && change.kind.type) || "update";
      title.textContent =
        { add: "added ", delete: "deleted ", update: "changed " }[kind] +
        change.path;
      body.appendChild(title);
      if (change.diff) {
        const pre = document.createElement("pre");
        change.diff.split("\n").forEach((line, index) => {
          if (index > 0) pre.appendChild(document.createTextNode("\n"));
          const span = document.createElement("span");
          if (line.startsWith("+") && !line.startsWith("+++"))
            span.className = "diff-add";
          if (line.startsWith("-") && !line.startsWith("---"))
            span.className = "diff-del";
          span.textContent = line;
          pre.appendChild(span);
        });
        body.appendChild(pre);
      }
    });
  }

  let renderQueued = new Set();
  function renderAgent(entry) {
    renderQueued.add(entry);
    if (renderQueued.size > 1) return;
    requestAnimationFrame(() => {
      const stick = isNearBottom();
      renderQueued.forEach((queued) => {
        queued.el.textContent = "";
        queued.el.appendChild(window.renderMarkdown(queued.text));
      });
      renderQueued = new Set();
      if (stick) scrollToBottom(true);
    });
  }

  function appendAgentDelta(itemId, delta) {
    let entry = state.items.get(itemId);
    if (!entry) {
      upsertItem({ id: itemId, type: "agentMessage", text: "" }, false);
      entry = state.items.get(itemId);
    }
    entry.text += delta || "";
    entry.el.classList.add("streaming");
    renderAgent(entry);
  }

  function appendCommandOutput(itemId, delta) {
    const entry = state.items.get(itemId);
    if (!entry) return;
    entry.text += delta || "";
    setActivityBody(entry.el, entry.text, "output");
  }

  function appendReasoning(itemId, delta) {
    let entry = state.items.get(itemId);
    if (!entry) {
      upsertItem({ id: itemId, type: "reasoning", summary: [] }, false);
      entry = state.items.get(itemId);
    }
    entry.text += delta || "";
    setActivityBody(entry.el, entry.text, "reasoning");
    entry.el.querySelector(".label").textContent =
      firstLine(entry.text) || "Thinking";
  }

  function finishStreaming() {
    state.items.forEach((entry) => entry.el.classList.remove("streaming"));
  }

  function firstLine(text) {
    return String(text || "")
      .replace(/[*#`_]/g, "")
      .trim()
      .split("\n")[0]
      .slice(0, 120);
  }

  function renderThread(thread) {
    clearConversation();
    state.threadCwd = thread.cwd || "";
    setTitle(thread.name || thread.preview || "New thread");
    $("subtitle").textContent = state.threadCwd;
    let running = null;
    (thread.turns || []).forEach((turn) => {
      (turn.items || []).forEach((item) =>
        upsertItem(item, turn.status !== "inProgress"),
      );
      if (turn.status === "inProgress") running = turn.id;
      if (turn.status === "failed" && turn.error)
        notice(turn.error.message || "The turn failed.", true);
    });
    setActiveTurn(running);
    if (!running) finishStreaming();
    updateEmptyState();
    scrollToBottom(true);
  }

  // ------------------------------------------------------------------
  // Threads
  // ------------------------------------------------------------------

  async function loadThreads() {
    try {
      const result = await rpc("thread/list", {
        limit: 40,
        sortKey: "updated_at",
      });
      state.threads = result.data || [];
    } catch (error) {
      state.threads = [];
    }
    renderThreadList();
  }

  function renderThreadList() {
    const list = $("thread-list");
    list.textContent = "";
    state.threads.forEach((thread) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      if (thread.id === state.threadId)
        button.setAttribute("aria-current", "true");
      const name = document.createElement("span");
      name.className = "thread-name";
      name.textContent = thread.name || thread.preview || "Untitled";
      const meta = document.createElement("span");
      meta.className = "thread-meta";
      meta.textContent =
        relativeTime(thread.updatedAt) + " · " + shortPath(thread.cwd);
      button.append(name, meta);
      button.addEventListener("click", () => {
        closeDrawer();
        openThread(thread.id);
      });
      li.appendChild(button);
      list.appendChild(li);
    });
    $("thread-list-empty").hidden = state.threads.length > 0;
  }

  async function openThread(threadId) {
    showView("chat");
    try {
      const result = await rpc("thread/resume", { threadId: threadId });
      state.threadId = result.thread.id;
      remember(THREAD_KEY, state.threadId);
      renderThread(result.thread);
      renderThreadList();
    } catch (error) {
      toast("Could not open the thread: " + error.message);
      if (state.threadId === threadId) newThreadView();
    }
  }

  function newThreadView() {
    state.threadId = null;
    state.threadCwd = "";
    forget(THREAD_KEY);
    clearConversation();
    setActiveTurn(null);
    setTitle("New thread");
    $("subtitle").textContent = state.workspace;
    renderThreadList();
    showView("chat");
  }

  async function resync() {
    if (!state.token) return;
    await refreshAccount();
    loadThreads();
    if (state.threadId && state.view === "chat") {
      try {
        const result = await rpc("thread/read", {
          threadId: state.threadId,
          includeTurns: true,
        });
        renderThread(result.thread);
      } catch (_) {
        /* the thread list shows what is left */
      }
    }
  }

  // ------------------------------------------------------------------
  // Sending
  // ------------------------------------------------------------------

  function setActiveTurn(turnId) {
    state.activeTurnId = turnId || null;
    $("stop").hidden = !state.activeTurnId;
    $("send").hidden = !!state.activeTurnId && !$("prompt").value.trim();
  }

  async function send(text) {
    const input = [{ type: "text", text: text, text_elements: [] }];
    const clientId = randomId();

    const bubble = document.createElement("div");
    bubble.className = "msg user pending";
    bubble.textContent = text;
    state.pendingUserMessages.set(clientId, bubble);
    append(bubble);
    scrollToBottom(true);

    try {
      if (!state.threadId) {
        const started = await rpc("thread/start", {});
        state.threadId = started.thread.id;
        state.threadCwd = started.thread.cwd || started.cwd || state.workspace;
        remember(THREAD_KEY, state.threadId);
        $("subtitle").textContent = state.threadCwd;
        setTitle(text.slice(0, 60));
      }
      if (state.activeTurnId) {
        // A turn is running: steer it instead of queueing a new one.
        await rpc("turn/steer", {
          threadId: state.threadId,
          expectedTurnId: state.activeTurnId,
          input: input,
          clientUserMessageId: clientId,
        });
      } else {
        const result = await rpc("turn/start", {
          threadId: state.threadId,
          input: input,
          clientUserMessageId: clientId,
        });
        if (result && result.turn) setActiveTurn(result.turn.id);
      }
    } catch (error) {
      bubble.classList.remove("pending");
      state.pendingUserMessages.delete(clientId);
      notice("Not sent: " + error.message, true);
      if (error.status === 401) unpair("The pairing token was not accepted.");
    }
  }

  async function interrupt() {
    if (!state.threadId || !state.activeTurnId) return;
    try {
      await rpc("turn/interrupt", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
      });
    } catch (error) {
      toast("Could not stop: " + error.message);
    }
  }

  // ------------------------------------------------------------------
  // Approvals
  // ------------------------------------------------------------------

  function approvalKey(id) {
    return JSON.stringify(id);
  }

  function addApproval(message) {
    const key = approvalKey(message.id);
    if (state.approvals.has(key)) return;
    const params = message.params || {};
    const card = document.createElement("div");
    card.className = "approval";
    card.setAttribute("role", "alertdialog");

    const title = document.createElement("h3");
    const isCommand =
      message.method === "item/commandExecution/requestApproval";
    title.textContent = isCommand
      ? "Run this command?"
      : "Apply these file changes?";
    card.appendChild(title);

    if (params.threadId && params.threadId !== state.threadId) {
      const other = document.createElement("p");
      other.className = "muted small";
      const thread = state.threads.find((t) => t.id === params.threadId);
      other.textContent =
        "In another thread: " +
        ((thread && (thread.name || thread.preview)) || params.threadId);
      card.appendChild(other);
    }
    if (isCommand && params.command) {
      const pre = document.createElement("pre");
      pre.textContent = params.command;
      card.appendChild(pre);
    }
    if (params.cwd) {
      const cwd = document.createElement("p");
      cwd.className = "muted small mono";
      cwd.textContent = "in " + params.cwd;
      card.appendChild(cwd);
    }
    if (!isCommand) {
      const entry = state.items.get(params.itemId);
      const changes = (entry && entry.item && entry.item.changes) || [];
      if (changes.length) {
        const pre = document.createElement("pre");
        pre.textContent = changes.map((change) => change.path).join("\n");
        card.appendChild(pre);
      }
      if (params.grantRoot) {
        const root = document.createElement("p");
        root.className = "muted small mono";
        root.textContent = "Write access to " + params.grantRoot;
        card.appendChild(root);
      }
    }
    if (params.reason) {
      const reason = document.createElement("p");
      reason.className = "small";
      reason.textContent = params.reason;
      card.appendChild(reason);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    approvalChoices(params).forEach(([label, className, decision]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", () =>
        answerApproval(message, decision, card),
      );
      actions.appendChild(button);
    });
    card.appendChild(actions);

    state.approvals.set(key, { message: message, el: card });
    $("approvals").appendChild(card);
    if (navigator.vibrate) {
      try {
        navigator.vibrate(30);
      } catch (_) {
        /* not supported */
      }
    }
  }

  // Codex may say which answers it accepts (`availableDecisions`); then only
  // those are offered. Otherwise the answers every version understands.
  function approvalChoices(params) {
    const offered = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : ["accept", "decline", "acceptForSession", "cancel"];
    const choices = [];
    offered.forEach((decision) => {
      if (decision === "accept") choices.push(["Approve", "primary", decision]);
      else if (decision === "decline")
        choices.push(["Decline", "secondary", decision]);
      else if (decision === "acceptForSession")
        choices.push(["Approve for this session", "secondary wide", decision]);
      else if (decision === "cancel")
        choices.push(["Decline and stop", "ghost wide", decision]);
      else if (decision && decision.acceptWithExecpolicyAmendment) {
        const rule =
          decision.acceptWithExecpolicyAmendment.execpolicy_amendment || [];
        choices.push([
          "Always allow: " + rule.join(" "),
          "secondary wide",
          decision,
        ]);
      }
      // Anything else (e.g. network rules) is left to the computer.
    });
    // A lone full-width button looks odd next to an empty cell.
    if (
      choices.length &&
      !choices.some(
        (choice) => choice[1] === "secondary" || choice[1] === "primary",
      )
    ) {
      choices[0][1] = "primary wide";
    }
    if (choices.filter((choice) => !/wide/.test(choice[1])).length === 1) {
      choices.forEach((choice) => {
        if (!/wide/.test(choice[1])) choice[1] += " wide";
      });
    }
    return choices;
  }

  async function answerApproval(message, decision, card) {
    card
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = true));
    try {
      await api("/api/respond", {
        id: message.id,
        result: { decision: decision },
      });
      removeApproval(message.id);
    } catch (error) {
      card
        .querySelectorAll("button")
        .forEach((button) => (button.disabled = false));
      toast("Could not answer: " + error.message);
      if (/no such pending request/.test(error.message))
        removeApproval(message.id);
    }
  }

  function removeApproval(id) {
    const key = approvalKey(id);
    const entry = state.approvals.get(key);
    if (entry) {
      entry.el.remove();
      state.approvals.delete(key);
    }
  }

  // ------------------------------------------------------------------
  // Account (the regular Codex login)
  // ------------------------------------------------------------------

  async function refreshAccount() {
    try {
      const result = await rpc("account/read", {});
      state.account = result.account || null;
      state.requiresAuth = !!result.requiresOpenaiAuth;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        unpair("The pairing token was not accepted.");
        return false;
      }
      toast("Codex is not reachable: " + error.message);
      return false;
    }
    renderAccount();
    const signedIn = !!state.account || !state.requiresAuth;
    if (!signedIn && state.view !== "login") showView("login");
    if (signedIn && state.view === "login") showView("chat");
    return signedIn;
  }

  function renderAccount() {
    const account = state.account;
    let line = "Not signed in";
    if (account && account.type === "chatgpt")
      line =
        "ChatGPT · " +
        (account.email || "account") +
        " · " +
        (account.planType || "");
    else if (account && account.type === "apiKey") line = "API key";
    else if (account && account.type === "amazonBedrock")
      line = "Amazon Bedrock";
    else if (!state.requiresAuth) line = "Custom model provider";
    $("account-line").textContent = line;
    $("logout-button").hidden = !account;
  }

  async function startLogin(params) {
    showError("login-error", "");
    try {
      const result = await rpc("account/login/start", params);
      if (result.type === "chatgptDeviceCode") {
        state.loginId = result.loginId;
        $("device-code-value").textContent = result.userCode;
        const link = $("device-code-link");
        if (/^https:\/\//.test(result.verificationUrl))
          link.href = result.verificationUrl;
        $("device-code").hidden = false;
        $("login-device").hidden = true;
      } else if (result.type === "chatgpt") {
        state.loginId = result.loginId;
        if (/^https:\/\//.test(result.authUrl))
          window.open(result.authUrl, "_blank", "noopener,noreferrer");
      } else {
        await refreshAccount();
      }
    } catch (error) {
      showError("login-error", error.message);
    }
  }

  function onLoginCompleted(params) {
    state.loginId = null;
    $("device-code").hidden = true;
    $("login-device").hidden = false;
    if (params.success) {
      toast("Signed in.");
      refreshAccount().then(loadThreads);
    } else {
      showError("login-error", params.error || "The sign-in did not complete.");
    }
  }

  async function cancelLogin() {
    if (state.loginId) {
      try {
        await rpc("account/login/cancel", { loginId: state.loginId });
      } catch (_) {
        /* it may have finished already */
      }
    }
    state.loginId = null;
    $("device-code").hidden = true;
    $("login-device").hidden = false;
  }

  // ------------------------------------------------------------------
  // Security (Chinook Security)
  // ------------------------------------------------------------------

  async function loadSecurity() {
    try {
      state.security = await api("/api/security");
    } catch (error) {
      showError("sec-error", error.message);
      return;
    }
    renderSecurity();
  }

  function renderSecurity() {
    const sec = state.security;
    if (!sec) return;
    $("sec-workspace").textContent = sec.workspace;
    let version = "not installed — start the bridge with --fetch-chinook";
    if (sec.available) {
      version = (sec.commit || "unknown commit").slice(0, 12);
      if (sec.matchesPin === false)
        version +=
          " (differs from the pinned " + sec.pinnedCommit.slice(0, 12) + ")";
      if (sec.matchesPin === true) version += " (pinned)";
    }
    $("sec-version").textContent = version;
    $("sec-run").disabled = !sec.available || sec.running;
    $("sec-progress").hidden = !sec.running;
    if (sec.running) $("sec-progress").textContent = "Scanning…";
    if (sec.lastResult) renderScanResult(sec.lastResult);
  }

  async function runScan() {
    showError("sec-error", "");
    $("sec-run").disabled = true;
    try {
      await api("/api/security/scan", { bots: [] });
      $("sec-progress").hidden = false;
      $("sec-progress").textContent = "Starting…";
    } catch (error) {
      $("sec-run").disabled = false;
      showError("sec-error", error.message);
    }
  }

  function securityProgress(params) {
    $("sec-progress").hidden = false;
    $("sec-progress").textContent = "Running " + params.bot + "…";
    $("sec-run").disabled = true;
  }

  function securityCompleted(result) {
    $("sec-progress").hidden = true;
    if (state.security) {
      state.security.running = false;
      state.security.lastResult = result;
    }
    $("sec-run").disabled = !(state.security && state.security.available);
    renderScanResult(result);
    const bad = result.bots.filter((bot) => bot.status !== "clean").length;
    toast(
      bad
        ? "Security scan finished — " + bad + " bot(s) need attention."
        : "Security scan finished — clean.",
    );
  }

  const STATUS_TEXT = {
    clean: "clean",
    findings: "findings",
    unproven: "proves nothing",
    error: "error",
  };

  function renderScanResult(result) {
    const container = $("sec-results");
    container.textContent = "";
    const meta = document.createElement("p");
    meta.className = "muted small";
    meta.textContent =
      "Last scan " +
      relativeTime(result.startedAt) +
      " · " +
      result.durationSeconds +
      "s · " +
      result.workspace;
    container.appendChild(meta);

    result.bots.forEach((bot) => {
      const card = document.createElement("details");
      card.className = "card bot-card";
      if (bot.status !== "clean")
        card.open =
          bot.status !== "findings" || (bot.findings || []).length <= 5;
      const head = document.createElement("summary");
      head.className = "bot-head";
      const name = document.createElement("h3");
      name.textContent = bot.bot;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.status = bot.status;
      const total = bot.summary ? bot.summary.total : 0;
      chip.textContent =
        bot.status === "findings"
          ? total + (total === 1 ? " finding" : " findings")
          : STATUS_TEXT[bot.status];
      head.append(name, chip);
      card.appendChild(head);

      if (bot.message) {
        const message = document.createElement("p");
        message.className =
          bot.status === "clean" ? "muted small" : "error small";
        message.textContent = bot.message;
        card.appendChild(message);
      }
      if (bot.status === "unproven") {
        const explain = document.createElement("p");
        explain.className = "muted small";
        explain.textContent =
          "This run could not determine anything. It does not count as passing.";
        card.appendChild(explain);
      }
      (bot.findings || []).forEach((finding) =>
        card.appendChild(renderFinding(finding)),
      );
      if (bot.truncated) {
        const more = document.createElement("p");
        more.className = "muted small";
        more.textContent =
          "Only the first " +
          bot.findings.length +
          " of " +
          total +
          " findings are shown.";
        card.appendChild(more);
      }
      container.appendChild(card);
    });
  }

  function renderFinding(finding) {
    const el = document.createElement("div");
    el.className = "finding";
    const title = document.createElement("p");
    const sev = document.createElement("span");
    sev.className = "sev";
    sev.dataset.sev = finding.severity;
    sev.textContent = finding.severity;
    const strong = document.createElement("strong");
    strong.textContent = finding.title || finding.rule;
    title.append(sev, strong);
    el.appendChild(title);
    const where = document.createElement("p");
    where.className = "where";
    const location = finding.location || {};
    where.textContent =
      (location.path || "?") +
      (location.line ? ":" + location.line : "") +
      " · " +
      finding.rule;
    el.appendChild(where);
    if (finding.explanation) {
      const p = document.createElement("p");
      p.textContent = finding.explanation;
      el.appendChild(p);
    }
    if (finding.remediation) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Fix: " + finding.remediation;
      el.appendChild(p);
    }
    return el;
  }

  // ------------------------------------------------------------------
  // Views, drawer, helpers
  // ------------------------------------------------------------------

  function showView(name) {
    state.view = name;
    ["pair", "login", "chat", "security"].forEach((view) => {
      $("view-" + view).hidden = view !== name;
    });
    $("composer-bar").hidden = name !== "chat";
    $("approvals").hidden = name === "pair" || name === "login";
    const inApp = name === "chat" || name === "security";
    $("new-thread-button").hidden = !inApp;
    $("menu-button").hidden = !inApp;
    $("tab-threads").setAttribute("aria-selected", String(name === "chat"));
    $("tab-security").setAttribute(
      "aria-selected",
      String(name === "security"),
    );
    if (name === "security") {
      setTitle("Security");
      $("subtitle").textContent = "Chinook Security";
      loadSecurity();
    }
    if (name === "chat" && !state.threadId) {
      setTitle("New thread");
      $("subtitle").textContent = state.workspace;
    }
    updateDrawerForLayout();
  }

  function setTitle(text) {
    $("title").textContent = text || "Codex";
    document.title = (text ? text + " · " : "") + "Codex Mobile";
  }

  const wideLayout = window.matchMedia("(min-width: 900px)");

  function updateDrawerForLayout() {
    const inApp = state.view === "chat" || state.view === "security";
    if (wideLayout.matches) {
      $("drawer").hidden = !inApp;
      $("scrim").hidden = true;
    } else if (
      !$("menu-button").getAttribute("aria-expanded") ||
      $("menu-button").getAttribute("aria-expanded") === "false"
    ) {
      $("drawer").hidden = true;
    }
  }

  function openDrawer() {
    loadThreads();
    $("drawer").hidden = false;
    $("scrim").hidden = false;
    $("menu-button").setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    $("menu-button").setAttribute("aria-expanded", "false");
    if (wideLayout.matches) return;
    $("drawer").hidden = true;
    $("scrim").hidden = true;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function showError(id, text) {
    const el = $(id);
    el.textContent = text || "";
    el.hidden = !text;
  }

  function relativeTime(seconds) {
    if (!seconds) return "";
    const diff = Date.now() / 1000 - seconds;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " d ago";
    return new Date(seconds * 1000).toLocaleDateString();
  }

  function shortPath(path) {
    if (!path) return "";
    const parts = String(path).split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/");
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // localStorage can be missing or throw (private mode); the app still works,
  // it just asks for the token again next time.
  function remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      /* not persisted */
    }
  }
  function recall(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }
  function forget(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* nothing to forget */
    }
  }

  function unpair(reason) {
    if (state.streamAbort) state.streamAbort.abort();
    state.token = null;
    forget(TOKEN_KEY);
    forget(THREAD_KEY);
    showView("pair");
    showError("pair-error", reason || "");
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------

  function tokenFromFragment() {
    const match = location.hash.match(/token=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    // Remove the token from the address bar and from history.
    history.replaceState(null, "", location.pathname + location.search);
    return match[1];
  }

  async function pair(token) {
    state.token = token;
    try {
      const status = await api("/api/status");
      state.workspace = status.workspace;
    } catch (error) {
      state.token = null;
      showView("pair");
      showError(
        "pair-error",
        error.status === 401 ? "That token was not accepted." : error.message,
      );
      return;
    }
    remember(TOKEN_KEY, token);
    showError("pair-error", "");
    connectEvents();
    const signedIn = await refreshAccount();
    if (!signedIn) return;
    await loadThreads();
    const last = recall(THREAD_KEY);
    if (last && state.threads.some((thread) => thread.id === last))
      openThread(last);
    else newThreadView();
  }

  function autoGrow() {
    const prompt = $("prompt");
    prompt.style.height = "auto";
    prompt.style.height =
      Math.min(prompt.scrollHeight, window.innerHeight * 0.4) + "px";
    $("send").hidden = !!state.activeTurnId && !prompt.value.trim();
  }

  function bind() {
    $("pair-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const token = $("pair-token").value.trim();
      if (token) pair(token);
    });
    $("menu-button").addEventListener("click", openDrawer);
    $("scrim").addEventListener("click", closeDrawer);
    $("new-thread-button").addEventListener("click", newThreadView);
    $("drawer-new-thread").addEventListener("click", () => {
      closeDrawer();
      newThreadView();
    });
    $("tab-threads").addEventListener("click", () => {
      closeDrawer();
      if (state.threadId) openThread(state.threadId);
      else newThreadView();
    });
    $("tab-security").addEventListener("click", () => {
      closeDrawer();
      showView("security");
    });
    $("logout-button").addEventListener("click", async () => {
      if (!confirm("Sign out of Codex on the computer running the bridge?"))
        return;
      try {
        await rpc("account/logout", {});
      } catch (error) {
        toast(error.message);
      }
      closeDrawer();
      refreshAccount();
    });
    $("unpair-button").addEventListener("click", () => {
      if (confirm("Forget the pairing token on this device?")) unpair("");
    });

    $("login-device").addEventListener("click", () =>
      startLogin({ type: "chatgptDeviceCode" }),
    );
    $("login-browser").addEventListener("click", () =>
      startLogin({ type: "chatgpt" }),
    );
    $("login-cancel").addEventListener("click", cancelLogin);
    $("device-code-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("device-code-value").textContent);
        toast("Code copied.");
      } catch (_) {
        toast("Copy is not available — select the code instead.");
      }
    });
    $("apikey-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const key = $("apikey").value.trim();
      if (!key) return;
      $("apikey").value = "";
      startLogin({ type: "apiKey", apiKey: key });
    });

    const prompt = $("prompt");
    prompt.addEventListener("input", autoGrow);
    prompt.addEventListener("keydown", (event) => {
      // Enter sends on a hardware keyboard; on a phone the return key makes a
      // new line and the send button sends.
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        window.matchMedia("(pointer: fine)").matches
      ) {
        event.preventDefault();
        $("composer").requestSubmit();
      }
    });
    $("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text) return;
      prompt.value = "";
      autoGrow();
      send(text);
    });
    $("stop").addEventListener("click", interrupt);
    $("sec-run").addEventListener("click", runScan);

    wideLayout.addEventListener("change", updateDrawerForLayout);
    document.addEventListener("visibilitychange", () => {
      // Coming back from the lock screen: catch up on what was missed.
      if (document.visibilityState === "visible" && state.token) resync();
    });
  }

  function start() {
    bind();
    const token = tokenFromFragment() || recall(TOKEN_KEY);
    if (token) pair(token);
    else showView("pair");
  }

  start();
})();
