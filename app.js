(function () {
  "use strict";

  const QBL_QUESTION_COUNT = 3;

  const els = {
    accessGate: document.getElementById("accessGate"),
    accessForm: document.getElementById("accessForm"),
    accessCodeInput: document.getElementById("accessCodeInput"),
    accessError: document.getElementById("accessError"),
    accessSubmitButton: document.getElementById("accessSubmitButton"),
    themeToggle: document.getElementById("themeToggle"),
    themeToggleText: document.getElementById("themeToggleText"),
    courseDescription: document.getElementById("courseDescription"),
    learningGoal: document.getElementById("learningGoal"),
    selectedSkill: document.getElementById("selectedSkill"),
    sourceText: document.getElementById("sourceText"),
    generateButton: document.getElementById("generateButton"),
    clearButton: document.getElementById("clearButton"),
    editButton: document.getElementById("editButton"),
    generationLoader: document.getElementById("generationLoader"),
    loadingText: document.getElementById("loadingText"),
    loadingPercent: document.getElementById("loadingPercent"),
    loadingBar: document.getElementById("loadingBar"),
    statusMessage: document.getElementById("statusMessage"),
    emptyState: document.getElementById("emptyState"),
    knowledgeBank: document.getElementById("knowledgeBank"),
    knowledgeBankText: document.getElementById("knowledgeBankText"),
    quizForm: document.getElementById("quizForm"),
    quizActions: document.getElementById("quizActions"),
    prevQuestionButton: document.getElementById("prevQuestionButton"),
    nextQuestionButton: document.getElementById("nextQuestionButton"),
    submitButton: document.getElementById("submitButton"),
    progressText: document.getElementById("progressText"),
    progressBar: document.getElementById("progressBar"),
    report: document.getElementById("report"),
    reportScore: document.getElementById("reportScore"),
    weakAreaSummary: document.getElementById("weakAreaSummary"),
    feedbackList: document.getElementById("feedbackList"),
    nextRoundButton: document.getElementById("nextRoundButton"),
    restartButton: document.getElementById("restartButton"),
    roundLabel: document.getElementById("roundLabel"),
    mapSnapshots: document.getElementById("mapSnapshots"),
    canvas: document.getElementById("masteryCanvas"),
  };

  const state = {
    session: null,
    questions: [],
    answers: {},
    lockedAnswers: {},
    currentQuestionIndex: 0,
    advanceTimer: null,
    transitionTimer: null,
    isTransitioning: false,
    roundIndex: 1,
    history: [],
    mastery: {},
    weakAreas: [],
    previousQuestionIds: [],
    aiMode: false,
    aiModelUsed: "",
    courseDescription: "",
    learningGoal: "",
    selectedSkill: "",
    sourceText: "",
    knowledgeBank: "",
    course: "",
    learningGoals: [],
    skills: [],
    roundSize: QBL_QUESTION_COUNT,
    accessRequired: false,
  };

  initTheme();
  loadDefaultQblSetup();

  els.accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await verifyAccessCode();
  });

  els.clearButton.addEventListener("click", () => {
    const restoreExamples = window.confirm("Restore the example QBL setup? Choose Cancel to clear all fields.");
    resetQuiz({ fieldMode: restoreExamples ? "restore" : "clear", clearStatusMessage: true });
  });

  els.editButton.addEventListener("click", () => {
    els.sourceText.focus();
  });

  els.generateButton.addEventListener("click", () => {
    generateQuiz();
  });

  els.themeToggle.addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
  });

  function initTheme() {
    setTheme(getStoredTheme(), { persist: false });
  }

  function getStoredTheme() {
    try {
      return localStorage.getItem("adaptiveQuizTheme") === "dark" ? "dark" : "light";
    } catch (error) {
      return "light";
    }
  }

  function getTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function setTheme(theme, options) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    els.themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
    els.themeToggleText.textContent = nextTheme === "dark" ? "Light mode" : "Dark mode";

    if (options?.persist !== false) {
      try {
        localStorage.setItem("adaptiveQuizTheme", nextTheme);
      } catch (error) {
        // Theme still changes for this session if storage is blocked.
      }
    }

    renderInsights();
  }

  async function generateQuiz() {
    // The four editable QBL setup fields are read here before the app asks Gemini to generate the activity.
    const setup = readQblSetup();
    const generationText = buildGenerationContext(setup);
    const roundSize = QBL_QUESTION_COUNT;

    clearStatus();
    setLoading(8, "Reading your QBL setup");

    if (!setup.courseDescription || !setup.learningGoal || !setup.selectedSkill || !setup.sourceText) {
      showStatus("Complete the course description, learning goal, selected skill, and source text first.");
      hideLoading();
      return;
    }

    if (setup.sourceText.length < 40) {
      showStatus("Add a little more source text first. A short paragraph of notes is enough.");
      hideLoading();
      return;
    }

    els.generateButton.disabled = true;
    els.generateButton.textContent = "Generating";

    try {
      await pause(120);
      setLoading(34, "Building the QBL knowledge bank");
      await pause(120);

      const session = window.QuizEngine.createSession(generationText, { roundSize });

      if (!session.facts.length) {
        showStatus("I could not find enough clear study points. Try adding a few concrete notes, examples, steps, or decision points.");
        hideLoading();
        return;
      }

      state.session = session;
      state.courseDescription = setup.courseDescription;
      state.learningGoal = setup.learningGoal;
      state.selectedSkill = setup.selectedSkill;
      state.sourceText = setup.sourceText;
      state.aiMode = true;
      state.roundIndex = 1;
      state.history = [];
      state.mastery = {};
      state.weakAreas = [];
      state.previousQuestionIds = [];
      state.aiModelUsed = "";
      state.roundSize = roundSize;
      clearWeakAreaSummary();

      setLoading(58, "Asking Gemini for QBL questions");
      await startAiRound([]);

      const started = state.questions.length > 0;
      if (!started) {
        showStatus("The setup was readable, but I could not form QBL questions from it. Add one or two more source details and try again.");
        hideLoading();
        return;
      }

      setLoading(100, "QBL activity ready");
      showStatus(getSuccessMessage(), "success");
      els.editButton.classList.remove("hidden");
      await pause(450);
      hideLoading();
    } catch (error) {
      console.error(error);
      if (error.accessDenied) {
        hideLoading();
        showAccessGate(error.message);
        showStatus("Enter the access code to use AI questions.");
        return;
      }
      if (state.session?.facts?.length) {
        setLoading(72, "Using offline fallback");
        state.aiMode = false;
        const started = startRound([]);
        hideLoading();
        showStatus(started ? `Gemini backend failed: ${error.message}. I built an offline fallback quiz instead.` : `Gemini backend failed: ${error.message}.`, started ? "success" : undefined);
      } else {
        hideLoading();
        showStatus(`QBL generation failed: ${error.message}`);
      }
    } finally {
      els.generateButton.disabled = false;
      els.generateButton.textContent = "Generate QBL";
    }
  }
  els.quizForm.addEventListener("change", (event) => {
    if (event.target.matches("input[type='radio']")) {
      const questionId = event.target.name;
      if (state.lockedAnswers[questionId]) {
        renderQuestions();
        return;
      }

      state.answers[questionId] = event.target.value;
      state.lockedAnswers[questionId] = true;
      // Answer-specific QBL feedback is displayed by re-rendering the current question after the learner submits an option.
      if (questionId === state.questions[state.currentQuestionIndex]?.id) renderQuestions();
      updateProgress();
      renderInsights();
    }
  });

  els.prevQuestionButton.addEventListener("click", () => {
    moveToQuestion(state.currentQuestionIndex - 1);
  });

  els.nextQuestionButton.addEventListener("click", () => {
    moveToQuestion(state.currentQuestionIndex + 1);
  });

  els.quizForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.questions.length) return;

    const result = window.QuizEngine.gradeRound(state.questions, state.answers);
    state.history.push(result);
    state.weakAreas = result.weakAreas;
    state.previousQuestionIds.push(...state.questions.map((question) => question.id));
    updateMastery(result);
    renderReport(result);
    renderInsights();
    els.quizActions.classList.add("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  els.nextRoundButton.addEventListener("click", async () => {
    state.roundIndex += 1;
    clearStatus();
    els.nextRoundButton.disabled = true;

    try {
      if (state.aiMode) {
        setLoading(18, "Preparing adaptive AI round");
        await startAiRound(state.weakAreas);
        setLoading(100, "Follow-up ready");
        showStatus("Built a new AI round from the missed areas.", "success");
        await pause(350);
        hideLoading();
      } else {
        startRound(state.weakAreas);
      }
    } catch (error) {
      console.error(error);
      if (error.accessDenied) {
        showAccessGate(error.message);
        showStatus("Enter the access code to continue with AI questions.");
        return;
      }
      if (state.session?.facts?.length) {
        state.aiMode = false;
        startRound(state.weakAreas);
        showStatus(`AI follow-up failed: ${error.message}. I switched to the offline fallback.`, "success");
      } else {
        showStatus(`AI follow-up failed: ${error.message}`);
      }
      hideLoading();
    } finally {
      els.nextRoundButton.disabled = false;
    }
  });

  els.restartButton.addEventListener("click", () => {
    resetQuiz({ clearStatusMessage: true });
    els.sourceText.focus();
  });

  window.addEventListener("resize", () => renderMasteryCanvas());

  async function startAiRound(weakAreas) {
    setLoading(74, weakAreas.length ? "Targeting weak areas" : "Checking question quality");
    const mistakes = state.history.flatMap((result) => result.items.filter((item) => !item.isCorrect));
    const aiRound = await window.AiQuizService.generateQuiz({
      courseDescription: state.courseDescription,
      learningGoal: state.learningGoal,
      selectedSkill: state.selectedSkill,
      text: state.sourceText,
      roundSize: state.roundSize,
      weakAreas,
      previousMistakes: mistakes,
      roundIndex: state.roundIndex,
    });

    state.answers = {};
    state.lockedAnswers = {};
    state.questions = aiRound.questions;
    state.knowledgeBank = aiRound.knowledgeBank || "";
    state.course = aiRound.course || state.courseDescription || "";
    state.learningGoal = aiRound.learningGoal || state.learningGoal || "";
    state.selectedSkill = aiRound.skill || state.selectedSkill || "";
    state.learningGoals = aiRound.learningGoals || (state.learningGoal ? [state.learningGoal] : []);
    state.skills = aiRound.skills || (state.selectedSkill ? [state.selectedSkill] : []);
    state.currentQuestionIndex = 0;
    state.aiModelUsed = aiRound.modelUsed || "Gemini";
    syncAiAreas(aiRound.questions);
    renderActiveRound();
    return true;
  }

  function startRound(weakAreas) {
    state.answers = {};
    state.lockedAnswers = {};
    state.currentQuestionIndex = 0;
    state.questions = window.QuizEngine.generateRound(state.session, {
      weakAreas,
      roundIndex: state.roundIndex,
      previousQuestionIds: state.previousQuestionIds,
      roundSize: state.roundSize,
    });

    if (!state.questions.length) {
      return false;
    }

    renderActiveRound();
    return true;
  }

  function renderActiveRound() {
    els.roundLabel.textContent = `Round ${state.roundIndex}`;
    els.emptyState.classList.add("hidden");
    els.report.classList.add("hidden");
    els.quizForm.classList.remove("hidden");
    els.quizActions.classList.remove("hidden");
    renderKnowledgeBank();
    renderQuestions();
    renderInsights();
    updateProgress();
  }

  function syncAiAreas(questions) {
    const areaMap = new Map();
    questions.forEach((question) => {
      const current = areaMap.get(question.area) || { name: question.area, count: 0, keywords: [] };
      current.count += 1;
      if (question.skillTag && !current.keywords.includes(question.skillTag)) current.keywords.push(question.skillTag);
      areaMap.set(question.area, current);
    });

    state.session = state.session || { facts: [], areas: [], hash: Date.now(), config: { roundSize: QBL_QUESTION_COUNT } };
    const existing = state.session.areas || [];
    const aiAreas = Array.from(areaMap.values());
    const merged = new Map(existing.map((area) => [area.name, area]));
    aiAreas.forEach((area) => merged.set(area.name, area));
    state.session.areas = Array.from(merged.values()).slice(0, 8);
  }

  function renderQuestions(direction) {
    if (!state.questions.length) {
      els.quizForm.innerHTML = "";
      return;
    }

    state.currentQuestionIndex = clamp(state.currentQuestionIndex, 0, state.questions.length - 1);
    const question = state.questions[state.currentQuestionIndex];
    const selectedAnswer = state.answers[question.id];
    const isLocked = Boolean(state.lockedAnswers[question.id]);
    const selectedOption = question.options.find((option) => option.id === selectedAnswer);
    const options = question.options
      .map((option, optionIndex) => {
        const letter = option.id || String.fromCharCode(65 + optionIndex);
        const checked = selectedAnswer === option.id ? "checked" : "";
        const disabled = isLocked ? "disabled" : "";
        const rowState = isLocked ? " locked" : "";
        return `
          <label class="option-row${rowState}">
            <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" ${checked} ${disabled} />
            <span class="option-letter">${escapeHtml(letter)}</span>
            <span>${escapeHtml(option.text)}</span>
          </label>
        `;
      })
      .join("");
    // Answer-specific feedback is displayed here directly under the selected option set after the answer is locked.
    const feedback = selectedOption?.feedback && isLocked
      ? `<div class="option-feedback ${selectedOption.id === question.answerId ? "correct" : "wrong"}" role="status"><p class="answer-lock-note">Answer submitted. Review the feedback, then continue.</p><p>${escapeHtml(selectedOption.feedback)}</p></div>`
      : "";

    els.quizForm.innerHTML = `
      <fieldset class="question-card">
        <div class="question-meta">
          <span>Question ${state.currentQuestionIndex + 1} of ${state.questions.length}</span>
          <span class="area-chip">${escapeHtml(question.difficulty || question.area)}</span>
        </div>
        <legend>${escapeHtml(question.prompt)}</legend>
        <div class="option-grid">${options}</div>
        ${feedback}
      </fieldset>
    `;

    const card = els.quizForm.querySelector(".question-card");
    if (card && direction) {
      card.classList.add(direction === "backward" ? "question-card-enter-backward" : "question-card-enter-forward");
    }
  }

  function renderKnowledgeBank() {
    if (!els.knowledgeBank || !els.knowledgeBankText) return;
    const knowledgeBank = state.knowledgeBank.trim();
    els.knowledgeBank.classList.toggle("hidden", !knowledgeBank);
    els.knowledgeBankText.textContent = knowledgeBank;
  }

  function updateProgress() {
    const answered = Object.keys(state.lockedAnswers).length;
    const total = state.questions.length;
    const currentQuestionId = state.questions[state.currentQuestionIndex]?.id;
    const pct = total ? Math.round((answered / total) * 100) : 0;
    els.progressText.textContent = `${answered} of ${total} submitted`;
    els.progressBar.style.width = `${pct}%`;
    els.submitButton.disabled = answered !== total;
    els.prevQuestionButton.disabled = !total || state.currentQuestionIndex === 0;
    els.nextQuestionButton.disabled = !total || state.currentQuestionIndex >= total - 1 || !state.lockedAnswers[currentQuestionId];
    els.submitButton.classList.toggle("hidden", state.currentQuestionIndex < total - 1);
    els.nextQuestionButton.classList.toggle("hidden", state.currentQuestionIndex >= total - 1);
  }

  function moveToQuestion(index) {
    clearTimeout(state.advanceTimer);
    if (!state.questions.length) return;
    if (state.isTransitioning) return;

    const targetIndex = clamp(index, 0, state.questions.length - 1);
    if (targetIndex === state.currentQuestionIndex) return;

    const direction = targetIndex > state.currentQuestionIndex ? "forward" : "backward";
    state.isTransitioning = true;
    els.quizForm.classList.remove("question-stack-leave-forward", "question-stack-leave-backward");
    els.quizForm.classList.add(direction === "backward" ? "question-stack-leave-backward" : "question-stack-leave-forward");

    clearTimeout(state.transitionTimer);
    state.transitionTimer = setTimeout(() => {
      state.currentQuestionIndex = targetIndex;
      els.quizForm.classList.remove("question-stack-leave-forward", "question-stack-leave-backward");
      renderQuestions(direction);
      renderInsights();
      updateProgress();
      state.isTransitioning = false;
    }, 130);
  }

  function renderReport(result) {
    els.report.classList.remove("hidden");
    els.reportScore.textContent = state.aiMode ? "QBL round complete" : `${result.correct}/${result.total}`;
    els.nextRoundButton.classList.toggle("hidden", result.mastered);
    renderWeakAreaSummary(result);

    els.feedbackList.innerHTML = result.items
      .map((item, index) => {
        const className = item.isCorrect ? "correct" : "wrong";
        const label = item.isCorrect ? "Correct" : "Incorrect";
        return `
          <article class="feedback-item ${className}">
            <div class="feedback-title">
              <span>Question ${index + 1}</span>
              <span>${label}</span>
            </div>
            <p>${escapeHtml(item.feedback || item.explanation || "")}</p>
          </article>
        `;
      })
      .join("");

    if (result.mastered) {
      renderInsights();
    } else {
      renderInsights();
    }
  }

  function renderWeakAreaSummary(result) {
    const weakAreas = result.weakAreas || [];
    els.weakAreaSummary.classList.remove("hidden");
    if (!weakAreas.length) {
      els.weakAreaSummary.textContent = "All correct, well done!";
      els.weakAreaSummary.classList.add("mastered");
      return;
    }

    const label = weakAreas.length === 1 ? "Weak area" : "Weak areas";
    els.weakAreaSummary.innerHTML = `<strong>${label}:</strong> ${weakAreas.map(escapeHtml).join(", ")}`;
    els.weakAreaSummary.classList.remove("mastered");
  }

  function clearWeakAreaSummary() {
    els.weakAreaSummary.classList.add("hidden");
    els.weakAreaSummary.textContent = "";
    els.weakAreaSummary.classList.remove("mastered");
  }

  function renderInsights() {
    renderMapSnapshots();
    renderMasteryCanvas();
  }

  function renderMapSnapshots() {
    const colors = getThemeColors();
    const completedRounds = state.history.filter((result) => result?.items?.length);
    els.mapSnapshots.classList.toggle("hidden", completedRounds.length === 0);
    els.mapSnapshots.innerHTML = "";

    completedRounds.forEach((result, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      canvas.className = "map-snapshot";
      canvas.setAttribute("aria-label", `Round ${index + 1}: ${result.correct} of ${result.total} correct`);
      drawSnapshotMap(canvas, result, colors);
      els.mapSnapshots.appendChild(canvas);
    });
  }

  function drawSnapshotMap(canvas, result, colors) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 18;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colors.mapBg;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    result.items.forEach((item, index) => {
      const angle = (Math.PI * 2 * index) / result.items.length - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      ctx.strokeStyle = colors.mapLink;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = item.isCorrect ? colors.correct : colors.pending;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function renderMasteryCanvas() {
    const canvas = els.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.round(rect.width * dpr));
    const height = Math.max(220, Math.round(rect.height * dpr));
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const cssWidth = width / dpr;
    const cssHeight = height / dpr;
    const colors = getThemeColors();
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = colors.mapBg;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const nodes = getMasteryNodes();
    if (!nodes.length) {
      drawEmptyCanvas(ctx, cssWidth, cssHeight, colors);
      return;
    }

    const centerX = cssWidth / 2;
    const centerY = cssHeight / 2 + 10;
    const radius = Math.max(58, Math.min(cssWidth, cssHeight) * 0.31);

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    nodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const color =
        node.status === "correct"
          ? colors.correct
          : node.status === "current"
            ? colors.current
            : node.status === "done"
              ? colors.done
              : colors.pending;

      ctx.strokeStyle = colors.mapLink;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = colors.mapCenter;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors.accent;
    ctx.font = "900 13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Score", centerX, centerY - 7);
    ctx.fillStyle = colors.ink;
    ctx.font = "800 15px Inter, system-ui, sans-serif";
    const currentResult = getCurrentRoundResult();
    ctx.fillText(currentResult ? `${currentResult.correct}/${currentResult.total}` : `0/${nodes.length}`, centerX, centerY + 12);
  }

  function getMasteryNodes() {
    if (state.questions.length) {
      const currentResult = getCurrentRoundResult();
      return state.questions.map((question, index) => {
        const resultItem = currentResult?.items?.find((item) => item.id === question.id);
        return {
          status: resultItem
            ? resultItem.isCorrect
              ? "correct"
              : "wrong"
            : index === state.currentQuestionIndex
              ? "current"
              : state.answers[question.id]
                ? "done"
                : "pending",
        };
      });
    }

    return (state.session?.areas || []).slice(0, state.roundSize).map(() => ({
      status: "pending",
    }));
  }

  function getCurrentRoundResult() {
    const latest = state.history[state.history.length - 1];
    if (!latest?.items?.length || !state.questions.length) return null;

    const currentIds = new Set(state.questions.map((question) => question.id));
    return latest.items.every((item) => currentIds.has(item.id)) ? latest : null;
  }

  function drawEmptyCanvas(ctx, width, height, colors) {
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.font = "800 14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No map yet", width / 2, height / 2);
  }

  function getThemeColors() {
    return {
      mapBg: cssVar("--map-bg"),
      mapCenter: cssVar("--map-center"),
      mapLink: cssVar("--map-link"),
      line: cssVar("--line"),
      accent: cssVar("--accent"),
      ink: cssVar("--ink"),
      muted: cssVar("--muted"),
      correct: cssVar("--map-correct"),
      current: cssVar("--map-current"),
      done: cssVar("--map-done"),
      pending: cssVar("--map-pending"),
    };
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function updateMastery(result) {
    Object.values(result.perArea).forEach((area) => {
      if (!state.mastery[area.area]) {
        state.mastery[area.area] = { asked: 0, correct: 0, wrong: 0 };
      }
      state.mastery[area.area].asked += area.asked;
      state.mastery[area.area].correct += area.correct;
      state.mastery[area.area].wrong += area.wrong;
      if (area.wrong === 0) {
        state.mastery[area.area].wrong = 0;
      }
    });
  }

  function resetQuiz(options = {}) {
    state.session = null;
    state.questions = [];
    state.answers = {};
    state.lockedAnswers = {};
    state.currentQuestionIndex = 0;
    clearTimeout(state.advanceTimer);
    clearTimeout(state.transitionTimer);
    state.isTransitioning = false;
    state.roundIndex = 1;
    state.history = [];
    state.mastery = {};
    state.weakAreas = [];
    state.previousQuestionIds = [];
    state.aiMode = false;
    state.aiModelUsed = "";
    state.courseDescription = "";
    state.learningGoal = "";
    state.selectedSkill = "";
    state.sourceText = "";
    state.knowledgeBank = "";
    state.course = "";
    state.learningGoals = [];
    state.skills = [];
    state.roundSize = QBL_QUESTION_COUNT;

    if (options.fieldMode === "restore") {
      setQblSetup(getDefaultQblSetup());
    } else if (options.fieldMode === "clear" || options.clearSource) {
      setQblSetup({ courseDescription: "", learningGoal: "", selectedSkill: "", sourceText: "" });
    }

    els.roundLabel.textContent = "Round 1";
    els.emptyState.classList.remove("hidden");
    els.quizForm.classList.add("hidden");
    els.quizActions.classList.add("hidden");
    els.report.classList.add("hidden");
    els.feedbackList.innerHTML = "";
    if (els.knowledgeBank) els.knowledgeBank.classList.add("hidden");
    if (els.knowledgeBankText) els.knowledgeBankText.textContent = "";
    els.reportScore.textContent = "";
    els.progressText.textContent = "0 of 0 answered";
    els.progressBar.style.width = "0%";
    els.submitButton.disabled = true;
    els.submitButton.classList.remove("hidden");
    els.nextQuestionButton.classList.remove("hidden");
    els.nextRoundButton.classList.add("hidden");
    clearWeakAreaSummary();
    els.editButton.classList.add("hidden");
    els.quizForm.innerHTML = "";
    hideLoading();
    if (options.clearStatusMessage) {
      clearStatus();
    }
    renderInsights();
  }

  async function initializeAccessGate() {
    try {
      const config = await window.AiQuizService.getConfig();
      state.accessRequired = Boolean(config.accessRequired);
      if (state.accessRequired && !window.AiQuizService.getAccessCode()) {
        showAccessGate();
      }
    } catch (error) {
      state.accessRequired = false;
    }
  }

  async function verifyAccessCode() {
    const accessCode = els.accessCodeInput.value.trim();
    if (!accessCode) {
      els.accessError.textContent = "Enter the access code.";
      return;
    }

    els.accessSubmitButton.disabled = true;
    els.accessSubmitButton.textContent = "Checking";

    try {
      await window.AiQuizService.verifyAccessCode(accessCode);
      hideAccessGate();
      clearStatus();
    } catch (error) {
      els.accessError.textContent = error.message || "Access code is incorrect.";
      els.accessCodeInput.select();
    } finally {
      els.accessSubmitButton.disabled = false;
      els.accessSubmitButton.textContent = "Continue";
    }
  }

  function showAccessGate(message) {
    if (!els.accessGate) return;
    els.accessError.textContent = message || "";
    els.accessGate.classList.remove("hidden");
    document.body.classList.add("access-locked");
    setTimeout(() => els.accessCodeInput.focus(), 0);
  }

  function hideAccessGate() {
    if (!els.accessGate) return;
    els.accessError.textContent = "";
    els.accessGate.classList.add("hidden");
    document.body.classList.remove("access-locked");
  }

  function showStatus(message, tone) {
    els.statusMessage.classList.toggle("success", tone === "success");
    els.statusMessage.textContent = message;
  }

  function getSuccessMessage() {
    if (state.aiMode) {
      return `Built a QBL knowledge bank and ${state.questions.length} questions with ${formatModelName(state.aiModelUsed || "Gemini")}.`;
    }

    const count = state.session?.facts?.length || 0;
    return `Built ${state.questions.length} questions from ${count} study point${count === 1 ? "" : "s"}.`;
  }

  function getQuestionCountForText(text) {
    return QBL_QUESTION_COUNT;
  }

  function loadDefaultQblSetup() {
    const defaults = getDefaultQblSetup();
    if (!els.courseDescription.value.trim() && !els.learningGoal.value.trim() && !els.selectedSkill.value.trim() && !els.sourceText.value.trim()) {
      setQblSetup(defaults);
    }
  }

  function getDefaultQblSetup() {
    const defaults = window.AiQuizService?.getDefaultQblSetup?.() || {};
    return {
      courseDescription: defaults.courseDescription || "",
      learningGoal: defaults.learningGoal || "",
      selectedSkill: defaults.selectedSkill || "",
      sourceText: defaults.sourceText || window.AiQuizService?.getDefaultQblSourceText?.() || "",
    };
  }

  function setQblSetup(setup) {
    els.courseDescription.value = setup.courseDescription || "";
    els.learningGoal.value = setup.learningGoal || "";
    els.selectedSkill.value = setup.selectedSkill || "";
    els.sourceText.value = setup.sourceText || "";
  }

  function readQblSetup() {
    return {
      courseDescription: cleanField(els.courseDescription.value),
      learningGoal: cleanField(els.learningGoal.value),
      selectedSkill: cleanField(els.selectedSkill.value),
      sourceText: els.sourceText.value.trim(),
    };
  }

  function buildGenerationContext(setup) {
    return [
      `Course description:\n${setup.courseDescription}`,
      `Learning goal:\n${setup.learningGoal}`,
      `Selected skill:\n${setup.selectedSkill}`,
      `Source text:\n${setup.sourceText}`,
    ].join("\n\n");
  }

  function cleanField(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function countWords(text) {
    return (String(text || "").match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || []).length;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function formatModelName(modelName) {
    return String(modelName || "Gemini")
      .replace(/^gemini-/i, "Gemini ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function clearStatus() {
    els.statusMessage.classList.remove("success");
    els.statusMessage.textContent = "";
  }

  function setLoading(percent, text) {
    const safePercent = Math.max(0, Math.min(100, percent));
    els.generationLoader.classList.remove("hidden");
    els.loadingText.textContent = text;
    els.loadingPercent.textContent = `${safePercent}%`;
    els.loadingBar.style.width = `${safePercent}%`;
    els.generationLoader.querySelector(".loader-track").setAttribute("aria-valuenow", String(safePercent));
  }

  function hideLoading() {
    els.generationLoader.classList.add("hidden");
    els.loadingText.textContent = "Preparing QBL";
    els.loadingPercent.textContent = "0%";
    els.loadingBar.style.width = "0%";
    els.generationLoader.querySelector(".loader-track").setAttribute("aria-valuenow", "0");
  }

  function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  initializeAccessGate();
  renderMasteryCanvas();
})();
