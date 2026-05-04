(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.QuizEngine = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const STOP_WORDS = new Set([
    "about",
    "above",
    "after",
    "again",
    "against",
    "also",
    "although",
    "always",
    "among",
    "because",
    "been",
    "before",
    "being",
    "between",
    "both",
    "cannot",
    "could",
    "during",
    "each",
    "early",
    "every",
    "from",
    "have",
    "having",
    "into",
    "itself",
    "just",
    "like",
    "many",
    "more",
    "most",
    "much",
    "must",
    "only",
    "other",
    "over",
    "same",
    "should",
    "some",
    "such",
    "than",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "under",
    "until",
    "very",
    "what",
    "when",
    "where",
    "which",
    "while",
    "will",
    "with",
    "within",
    "without",
    "would",
  ]);

  const RELATION_WORDS = [
    "absorbs",
    "causes",
    "cause",
    "converts",
    "leads to",
    "results in",
    "produces",
    "uses",
    "use",
    "allows",
    "helps",
    "prevents",
    "reduces",
    "increases",
    "requires",
    "depends on",
    "supports",
    "controls",
    "regulates",
    "explains",
  ];

  const DEFINITION_WORDS = [
    "is defined as",
    "are defined as",
    "can be defined as",
    "refers to",
    "means",
    "is",
    "are",
    "was",
    "were",
  ];

  const SAMPLE_TEXT =
    "Photosynthesis is the process by which plants, algae, and some bacteria convert light energy into chemical energy stored in glucose. Chlorophyll absorbs red and blue wavelengths most efficiently, which is why many leaves appear green. In the light-dependent reactions, water molecules are split, oxygen is released, and ATP and NADPH are produced. The Calvin cycle uses carbon dioxide, ATP, and NADPH to build sugars in the stroma of the chloroplast. Stomata are small openings on leaves that allow carbon dioxide to enter, but they can also let water vapor escape. When light intensity increases, the rate of photosynthesis usually rises until another factor, such as carbon dioxide concentration or temperature, becomes limiting. Excessive heat can reduce photosynthesis because enzymes involved in the Calvin cycle lose their effective shape. Plants balance gas exchange and water conservation by opening and closing stomata.";

  function createSession(text, config) {
    const cleanText = normalizeText(text);
    const sentences = splitSentences(cleanText);
    const keywordCounts = countKeywords(sentences);
    const facts = sentences
      .map((sentence, index) => buildFact(sentence, index, keywordCounts))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const usableFacts = dedupeFacts(facts).slice(0, 18);

    if (!usableFacts.length) {
      return {
        text: cleanText,
        hash: hashString(cleanText || "empty"),
        facts: [],
        areas: [],
        config: Object.assign({ roundSize: 5 }, config || {}),
      };
    }

    const areas = buildAreas(usableFacts);

    return {
      text: cleanText,
      hash: hashString(cleanText),
      facts: usableFacts,
      areas,
      config: Object.assign({ roundSize: 5 }, config || {}),
    };
  }

  function generateRound(session, options) {
    if (!session?.facts?.length) return [];

    const settings = Object.assign(
      { weakAreas: [], roundIndex: 1, previousQuestionIds: [], roundSize: 5 },
      options || {},
    );
    const seed = session.hash + settings.roundIndex * 997;
    const rng = mulberry32(seed);
    const weakSet = new Set((settings.weakAreas || []).map(normalizeKey));
    const previousIds = new Set(settings.previousQuestionIds || []);

    let pool = session.facts;
    if (weakSet.size) {
      const focused = session.facts.filter((fact) => {
        if (weakSet.has(normalizeKey(fact.area))) return true;
        return fact.keywords.some((keyword) => weakSet.has(normalizeKey(keyword)));
      });
      if (focused.length) pool = focused;
    }

    const ordered = shuffle(pool, rng);
    const questions = [];
    const target = Math.max(1, settings.roundSize || session.config.roundSize || 5);
    let safety = 0;

    while (questions.length < target && safety < target * 8) {
      const fact = ordered[safety % ordered.length] || session.facts[safety % session.facts.length];
      const variant = (settings.roundIndex + safety + fact.index) % 5;
      const question = buildQuestion(fact, session.facts, {
        seed: seed + safety * 131,
        roundIndex: settings.roundIndex,
        variant,
      });

      if (!previousIds.has(question.id) || weakSet.size || questions.length >= pool.length) {
        if (!questions.some((item) => item.id === question.id)) {
          questions.push(question);
        }
      }
      safety += 1;
    }

    return questions;
  }

  function gradeRound(questions, answers) {
    const perArea = {};
    const items = questions.map((question) => {
      const chosenId = answers[question.id];
      const chosen = question.options.find((option) => option.id === chosenId);
      const correctOption = question.options.find((option) => option.id === question.answerId);
      const isCorrect = chosenId === question.answerId;

      if (!perArea[question.area]) {
        perArea[question.area] = { area: question.area, asked: 0, correct: 0, wrong: 0 };
      }
      perArea[question.area].asked += 1;
      perArea[question.area][isCorrect ? "correct" : "wrong"] += 1;

      return {
        id: question.id,
        area: question.area,
        prompt: question.prompt,
        chosen: chosen ? chosen.text : "",
        correct: correctOption ? correctOption.text : "",
        isCorrect,
        explanation: question.explanation,
        source: question.source,
      };
    });

    const correctCount = items.filter((item) => item.isCorrect).length;
    const weakAreas = Object.values(perArea)
      .filter((area) => area.wrong > 0)
      .sort((a, b) => b.wrong - a.wrong || a.area.localeCompare(b.area))
      .map((area) => area.area);

    return {
      total: questions.length,
      correct: correctCount,
      wrong: questions.length - correctCount,
      items,
      perArea,
      weakAreas,
      mastered: correctCount === questions.length,
    };
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function splitSentences(text) {
    const normalized = normalizeText(text)
      .replace(/^[\s>*-]*(?:\d+[.)]\s*)?/gm, "")
      .replace(/[•·]/g, "\n");
    const lineCandidates = normalized
      .split(/\n+/)
      .map((line) => cleanSentence(line))
      .filter(Boolean);
    const punctuationCandidates =
      normalized
        .replace(/\n+/g, ". ")
        .match(/[^.!?]+(?:[.!?]+|$)/g)
        ?.map((sentence) => cleanSentence(sentence)) || [];

    const candidates = lineCandidates.concat(punctuationCandidates);
    const pieces = candidates.flatMap(splitCandidate);
    const seen = new Set();

    return pieces.filter((sentence) => {
      const key = normalizeKey(sentence);
      if (wordCount(sentence) < 4 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function splitCandidate(sentence) {
    const clean = cleanSentence(sentence);
    const words = wordCount(clean);
    if (!clean || words < 4) return [];
    if (words <= 55) return [clean];

    const clausePieces = clean
      .split(/(?:;|:|\s+-\s+|\s+\|\s+|\s+\band\b\s+|\s+\bbut\b\s+|\s+\bwhile\b\s+|\s+\bwhereas\b\s+)/i)
      .map((piece) => cleanSentence(piece))
      .filter((piece) => wordCount(piece) >= 4 && wordCount(piece) <= 55);

    if (clausePieces.length >= 2) return clausePieces;
    return chunkLongSentence(clean);
  }

  function chunkLongSentence(sentence) {
    const words = sentence.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g) || [];
    const chunks = [];
    const maxWords = 34;
    const overlap = 5;
    let wordSeen = 0;
    let startToken = 0;

    for (let index = 0; index < words.length; index += 1) {
      if (/^[A-Za-z0-9]/.test(words[index])) wordSeen += 1;
      if (wordSeen >= maxWords || index === words.length - 1) {
        const chunk = cleanSentence(words.slice(startToken, index + 1).join(" ").replace(/\s+([,.;:!?])/g, "$1"));
        if (wordCount(chunk) >= 4) chunks.push(chunk);
        const rewind = Math.max(0, index - overlap * 2);
        startToken = rewind;
        wordSeen = 0;
      }
    }

    return chunks;
  }

  function cleanSentence(sentence) {
    return String(sentence || "")
      .replace(/\s+/g, " ")
      .replace(/^[-*]\s*/, "")
      .trim();
  }

  function wordCount(text) {
    return (String(text).match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || []).length;
  }

  function tokenize(text) {
    return (String(text).toLowerCase().match(/[a-z][a-z'-]{2,}|\d+(?:\.\d+)?%?/g) || []).filter(
      (token) => !STOP_WORDS.has(token) && token.length > 2,
    );
  }

  function countKeywords(sentences) {
    const counts = new Map();
    sentences.forEach((sentence) => {
      new Set(tokenize(sentence)).forEach((token) => {
        counts.set(token, (counts.get(token) || 0) + 1);
      });
    });
    return counts;
  }

  function buildFact(sentence, index, keywordCounts) {
    const words = wordCount(sentence);
    if (words < 4) return null;

    const definition = extractDefinition(sentence);
    const relation = extractRelation(sentence);
    const list = extractList(sentence);
    const keywords = rankKeywords(sentence, keywordCounts);
    const area = chooseArea(sentence, definition, relation, list, keywords);
    const score =
      words +
      (definition ? 26 : 0) +
      (relation ? 18 : 0) +
      (list ? 14 : 0) +
      Math.min(18, keywords.length * 4) +
      (/\d|%/.test(sentence) ? 8 : 0);

    return {
      id: `fact-${index}-${hashString(sentence)}`,
      index,
      sentence,
      source: sentence,
      definition,
      relation,
      list,
      keywords,
      area,
      score,
    };
  }

  function extractDefinition(sentence) {
    const escaped = DEFINITION_WORDS.map(escapeRegExp).join("|");
    const pattern = new RegExp(`^(.{2,90}?)\\s+(${escaped})\\s+(.{8,})$`, "i");
    const match = sentence.match(pattern);
    if (!match) return null;

    const term = cleanTerm(match[1]);
    const definition = stripTrailing(cleanSentence(match[3]));
    if (!term || !definition || wordCount(term) > 8 || isBadDefinitionSubject(match[1])) {
      return null;
    }
    if (/^(split|released|produced|absorbed|converted|used|stored|called|known)\b/i.test(definition)) {
      return null;
    }

    return {
      term,
      connector: match[2].toLowerCase(),
      definition,
    };
  }

  function extractRelation(sentence) {
    const escaped = RELATION_WORDS.map(escapeRegExp).join("|");
    const pattern = new RegExp(`^(.{2,90}?)\\s+(${escaped})\\s+(.{5,})$`, "i");
    const match = sentence.match(pattern);
    if (!match) return null;

    return {
      subject: cleanTerm(match[1]),
      verb: match[2].toLowerCase(),
      object: stripTrailing(cleanSentence(match[3])),
    };
  }

  function extractList(sentence) {
    const pattern = /^(.{2,90}?)\s+(includes|include|contains|contain|consists of|consist of|is made of|are made of|has|have)\s+(.{5,})$/i;
    const match = sentence.match(pattern);
    if (!match) return null;

    return {
      subject: cleanTerm(match[1]),
      verb: match[2].toLowerCase(),
      members: stripTrailing(cleanSentence(match[3])),
    };
  }

  function rankKeywords(sentence, keywordCounts) {
    return tokenize(sentence)
      .map((token) => ({
        token,
        score: token.length + Math.max(0, 8 - (keywordCounts.get(token) || 1)),
      }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.token)
      .filter((token, index, arr) => arr.indexOf(token) === index)
      .slice(0, 8);
  }

  function chooseArea(sentence, definition, relation, list, keywords) {
    if (definition?.term) return titleCase(definition.term);
    if (relation?.subject && !isBadDefinitionSubject(relation.subject)) {
      return titleCase(relation.subject);
    }
    if (list?.subject && !isBadDefinitionSubject(list.subject)) {
      return titleCase(list.subject);
    }

    const contextLead = sentence.match(/^(?:In|During|Within)\s+(?:the\s+)?([^,]{3,70}),/i);
    if (contextLead) return titleCase(trimConditionPhrase(contextLead[1]));

    const conditionLead = sentence.match(/^(?:When|If|Because|Although|While)\s+([^,]{3,70}),/i);
    if (conditionLead) return titleCase(trimConditionPhrase(conditionLead[1]));

    const subjectLead = sentence.match(
      /^(.{2,70}?)\s+(?:can|usually|often|must|will|may|might|should|balances|balance|contains|contain|includes|include|supports|support)\b/i,
    );
    if (subjectLead && !isBadDefinitionSubject(subjectLead[1])) {
      return titleCase(cleanTerm(subjectLead[1]));
    }

    const capitalPhrase = sentence.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/);
    if (capitalPhrase && wordCount(capitalPhrase[0]) <= 3) {
      return capitalPhrase[0];
    }

    return titleCase((keywords[0] || "Core concept").replace(/-/g, " "));
  }

  function isBadDefinitionSubject(subject) {
    const clean = cleanSentence(subject);
    const first = clean.split(/\s+/)[0]?.toLowerCase();
    return (
      !clean ||
      /[,;:]/.test(clean) ||
      /\b(which|that|who|where)\b/i.test(clean) ||
      wordCount(clean) > 7 ||
      ["in", "when", "if", "because", "although", "while", "during", "after", "before"].includes(first)
    );
  }

  function trimConditionPhrase(phrase) {
    return cleanTerm(phrase).replace(
      /\s+(increases|decreases|rises|falls|changes|occurs|happens|becomes|starts|ends)$/i,
      "",
    );
  }

  function buildAreas(facts) {
    const areaMap = new Map();
    facts.forEach((fact) => {
      if (!areaMap.has(fact.area)) {
        areaMap.set(fact.area, { name: fact.area, count: 0, keywords: new Set() });
      }
      const area = areaMap.get(fact.area);
      area.count += 1;
      fact.keywords.slice(0, 4).forEach((keyword) => area.keywords.add(keyword));
    });

    return Array.from(areaMap.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((area) => ({
        name: area.name,
        count: area.count,
        keywords: Array.from(area.keywords).slice(0, 6),
      }));
  }

  function dedupeFacts(facts) {
    const seen = new Set();
    return facts.filter((fact) => {
      const key = normalizeKey(fact.sentence.replace(/\d+/g, "#"));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildQuestion(fact, allFacts, settings) {
    if (settings.variant === 4) {
      return areaQuestion(fact, allFacts, settings);
    }
    if (fact.definition && settings.variant === 0) {
      return definitionQuestion(fact, allFacts, settings);
    }
    if (fact.relation && settings.variant === 1) {
      return relationQuestion(fact, allFacts, settings);
    }
    if (settings.variant === 2 || fact.list) {
      return clozeQuestion(fact, allFacts, settings);
    }
    return claimQuestion(fact, allFacts, settings);
  }

  function areaQuestion(fact, allFacts, settings) {
    const correct = fact.area;
    const prompt = `Which study area does this detail most directly test? "${shorten(fact.sentence, 170)}"`;
    const distractors = allFacts
      .filter((other) => other.id !== fact.id)
      .flatMap((other) => [other.area, ...other.keywords.slice(0, 2).map(titleCase)]);

    return makeQuestion({
      fact,
      type: "area",
      prompt,
      correct,
      distractors,
      settings,
      explanation: `This detail is mainly tied to ${fact.area}.`,
    });
  }

  function definitionQuestion(fact, allFacts, settings) {
    const correct = fact.definition.definition;
    const prompt = `Which option best explains ${fact.definition.term}?`;
    const distractors = [
      ...allFacts
        .filter((other) => other.id !== fact.id)
        .map(factAnswerText),
      changeKeyDetail(correct, fact, allFacts),
      reverseClaim(correct),
      absolutizeClaim(correct),
    ];

    return makeQuestion({
      fact,
      type: "definition",
      prompt,
      correct,
      distractors,
      settings,
      explanation: `${fact.definition.term} is described in the text as ${lowerFirst(correct)}`,
    });
  }

  function relationQuestion(fact, allFacts, settings) {
    const relation = fact.relation;
    const prompt = `According to the text, what does ${relation.subject} ${relation.verb}?`;
    const correct = relation.object;
    const distractors = [
      ...allFacts
        .filter((other) => other.id !== fact.id)
        .map((other) => other.relation?.object || other.list?.members || getKeyPhrase(other)),
      reverseClaim(`${relation.subject} ${relation.verb} ${relation.object}`),
      changeKeyDetail(correct, fact, allFacts),
      ...allFacts.filter((other) => other.id !== fact.id).map(factAnswerText),
    ];

    return makeQuestion({
      fact,
      type: "relationship",
      prompt,
      correct,
      distractors,
      settings,
      explanation: `The relationship in the source is: ${relation.subject} ${relation.verb} ${relation.object}`,
    });
  }

  function clozeQuestion(fact, allFacts, settings) {
    const phrase = chooseBlankPhrase(fact);
    const promptSentence = blankPhrase(fact.sentence, phrase);
    const prompt = `Which option best completes this sentence? "${promptSentence}"`;
    const distractors = [
      ...allFacts.filter((other) => other.id !== fact.id).map(getKeyPhrase),
      ...allFacts
        .filter((other) => other.id !== fact.id)
        .flatMap((other) => other.keywords.slice(0, 2).map(titleCase)),
      changeKeyDetail(phrase, fact, allFacts),
      reversePhrase(phrase),
    ];

    return makeQuestion({
      fact,
      type: "completion",
      prompt,
      correct: phrase,
      distractors,
      settings,
      explanation: `The missing phrase is taken from the source sentence about ${fact.area}.`,
    });
  }

  function claimQuestion(fact, allFacts, settings) {
    const prompt = `Which statement best matches the source's point about ${fact.area}?`;
    const correct = stripTrailing(fact.sentence);
    const distractors = [
      reverseClaim(correct),
      negateClaim(correct),
      absolutizeClaim(correct),
      ...allFacts
        .filter((other) => other.id !== fact.id)
        .slice(0, 4)
        .map(factAnswerText),
      changeKeyDetail(correct, fact, allFacts),
    ];

    return makeQuestion({
      fact,
      type: "claim",
      prompt,
      correct,
      distractors,
      settings,
      explanation: `The accurate statement keeps the original relationship and limits from the source.`,
    });
  }

  function makeQuestion(payload) {
    const rng = mulberry32(payload.settings.seed + hashString(payload.type + payload.fact.id));
    const options = makeOptions(payload.correct, payload.distractors, rng);
    const answer = options.find((option) => option.text === normalizeOption(payload.correct));
    return {
      id: `${payload.fact.id}-${payload.type}-${payload.settings.roundIndex}-${payload.settings.variant}`,
      area: payload.fact.area,
      type: payload.type,
      prompt: payload.prompt,
      options,
      answerId: answer.id,
      explanation: stripTrailing(payload.explanation),
      source: payload.fact.source,
    };
  }

  function makeOptions(correct, distractors, rng) {
    const cleanCorrect = normalizeOption(correct);
    const seen = new Set([normalizeKey(cleanCorrect)]);
    const options = [{ id: "correct", text: cleanCorrect }];

    distractors
      .map(normalizeOption)
      .filter(Boolean)
      .forEach((text) => {
        const key = normalizeKey(text);
        if (options.length < 5 && key !== normalizeKey(cleanCorrect) && !seen.has(key)) {
          seen.add(key);
          options.push({ id: `d${options.length}`, text });
        }
      });

    const fallback = [
      "The text mentions the topic, but does not make this exact claim.",
      "The statement reverses the relationship described in the source.",
      "The statement is broader than the source supports.",
      "The detail belongs to another area of the text.",
      "The text presents this as a condition, not as the main answer.",
    ];

    fallback.forEach((text) => {
      const key = normalizeKey(text);
      if (options.length < 5 && !seen.has(key)) {
        seen.add(key);
        options.push({ id: `d${options.length}`, text });
      }
    });

    return shuffle(options.slice(0, 5), rng).map((option, index) => ({
      id: option.id === "correct" ? "answer" : `option-${index}-${hashString(option.text)}`,
      text: option.text,
    }));
  }

  function getKeyPhrase(fact) {
    if (fact.definition) return fact.definition.term;
    if (fact.list) return fact.list.members.split(/,| and | or /i).find((part) => wordCount(part) >= 1)?.trim();
    if (fact.relation) return fact.relation.object.split(/,| and | or /i)[0].trim();
    return fact.area || titleCase(fact.keywords[0] || "Core concept");
  }

  function chooseBlankPhrase(fact) {
    if (fact.definition && wordCount(fact.definition.term) <= 5) return fact.definition.term;
    if (fact.list) return getKeyPhrase(fact);
    if (fact.relation && wordCount(fact.relation.object) <= 8) return fact.relation.object;
    const phrase = extractNounishPhrase(fact.sentence);
    if (phrase) return phrase;
    return titleCase(fact.keywords[0] || fact.area);
  }

  function extractNounishPhrase(sentence) {
    const matches = sentence.match(/\b[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){1,3}\b/g) || [];
    return (
      matches
        .map((phrase) => phrase.trim())
        .filter((phrase) => wordCount(phrase) >= 2 && !STOP_WORDS.has(phrase.split(" ")[0].toLowerCase()))
        .sort((a, b) => b.length - a.length)[0] || ""
    );
  }

  function blankPhrase(sentence, phrase) {
    const escaped = escapeRegExp(phrase);
    const replaced = sentence.replace(new RegExp(escaped, "i"), "_____");
    return replaced === sentence ? `${shorten(sentence, 140)} _____` : shorten(replaced, 180);
  }

  function changeKeyDetail(text, fact, allFacts) {
    const areaReplacements = allFacts
      .filter((other) => other.id !== fact.id)
      .flatMap((other) => [other.area, getKeyPhrase(other)])
      .map((item) => normalizeOption(item))
      .filter((item) => item && wordCount(item) <= 5 && !new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text));

    const keywordReplacements = allFacts
      .filter((other) => other.id !== fact.id)
      .flatMap((other) => other.keywords.slice(0, 3).map(titleCase))
      .map((item) => normalizeOption(item))
      .filter((item) => item && wordCount(item) <= 3 && !new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text));

    const targets = fact.keywords
      .concat([fact.definition?.term, fact.area])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    const usableTargets = targets.filter((item) => {
      const key = normalizeKey(item);
      return key.length > 3 && new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text);
    });

    const lateTarget = usableTargets.find((item) => {
      const index = text.toLowerCase().indexOf(item.toLowerCase());
      return index > text.length * 0.28;
    });
    const target = lateTarget || usableTargets[0];
    const replacements = areaReplacements.concat(keywordReplacements);
    const replacement = replacements.find((item) => normalizeKey(item) !== normalizeKey(target)) || "another source detail";
    if (target) {
      return replaceWithCase(text, target, replacement);
    }
    return swapKeyword(text, fact, allFacts);
  }

  function replaceWithCase(text, target, replacement) {
    const pattern = new RegExp(`\\b${escapeRegExp(target)}\\b`, "i");
    return text.replace(pattern, (match, offset) => {
      if (offset > 0 && match.charAt(0) === match.charAt(0).toLowerCase()) {
        return lowerFirst(replacement);
      }
      return replacement;
    });
  }

  function factAnswerText(fact) {
    if (fact.definition) return fact.definition.definition;
    if (fact.relation) return `${fact.relation.subject} ${fact.relation.verb} ${fact.relation.object}`;
    if (fact.list) return `${fact.list.subject} ${fact.list.verb} ${fact.list.members}`;
    return stripTrailing(fact.sentence);
  }

  function swapKeyword(text, fact, allFacts) {
    const replacementFact = allFacts.find((other) => other.id !== fact.id && other.area !== fact.area);
    const replacement = replacementFact?.area || titleCase((replacementFact?.keywords?.[0] || "another concept"));
    const targets = [fact.definition?.term, fact.area, ...fact.keywords].filter(Boolean);
    const target = targets.find((item) => new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text));
    if (!target) return `${text} in the context of ${replacement}`;
    return text.replace(new RegExp(`\\b${escapeRegExp(target)}\\b`, "i"), replacement);
  }

  function reverseClaim(text) {
    if (/light energy into chemical energy/i.test(text)) {
      return text.replace(/light energy into chemical energy/i, "chemical energy into light energy");
    }

    const swaps = [
      ["increases", "decreases"],
      ["increase", "decrease"],
      ["decreases", "increases"],
      ["decrease", "increase"],
      ["reduces", "raises"],
      ["reduce", "increase"],
      ["raises", "reduces"],
      ["raise", "reduce"],
      ["prevents", "causes"],
      ["prevent", "cause"],
      ["causes", "prevents"],
      ["cause", "prevent"],
      ["before", "after"],
      ["after", "before"],
      ["uses", "produces"],
      ["use", "produce"],
      ["produces", "uses"],
      ["produce", "use"],
      ["split", "combined"],
      ["enter", "leave"],
      ["released", "absorbed"],
      ["absorbed", "released"],
    ];
    for (const [from, to] of swaps) {
      const pattern = new RegExp(`\\b${from}\\b`, "i");
      if (pattern.test(text)) return text.replace(pattern, to);
    }
    return negateClaim(text);
  }

  function negateClaim(text) {
    const clean = stripTrailing(text);
    const replacements = [
      [/\bcan\b/i, "cannot"],
      [/\bdoes\b/i, "does not"],
      [/\bdo\b/i, "do not"],
      [/\bis\b/i, "is not"],
      [/\bare\b/i, "are not"],
      [/\buses\b/i, "does not use"],
      [/\bproduces\b/i, "does not produce"],
      [/\brequires\b/i, "does not require"],
    ];

    for (const [pattern, replacement] of replacements) {
      if (pattern.test(clean)) return clean.replace(pattern, replacement);
    }

    return `The text does not connect this idea to ${lowerFirst(clean)}`;
  }

  function reversePhrase(phrase) {
    if (/\band\b/i.test(phrase)) {
      return phrase.split(/\band\b/i).reverse().join(" and ").trim();
    }
    return `not ${lowerFirst(phrase)}`;
  }

  function absolutizeClaim(text) {
    if (/\busually\b|\bcan\b|\bmay\b|\boften\b|\bsome\b/i.test(text)) {
      return text
        .replace(/\busually\b/gi, "always")
        .replace(/\bcan\b/gi, "must")
        .replace(/\bmay\b/gi, "always")
        .replace(/\boften\b/gi, "always")
        .replace(/\bsome\b/gi, "all");
    }
    return "";
  }

  function normalizeOption(text) {
    const clean = stripTrailing(cleanSentence(text));
    if (!clean) return "";
    return clean.length > 240 ? `${clean.slice(0, 237).trim()}...` : clean;
  }

  function cleanTerm(term) {
    return stripTrailing(cleanSentence(term))
      .replace(/^(the|a|an)\s+/i, "")
      .replace(/\s+(that|which|who)$/i, "")
      .trim();
  }

  function stripTrailing(text) {
    return String(text || "")
      .replace(/[.!?;:]+$/g, "")
      .trim();
  }

  function shorten(text, max) {
    const clean = cleanSentence(text);
    if (clean.length <= max) return clean;
    const sliced = clean.slice(0, max - 3);
    return `${sliced.slice(0, Math.max(0, sliced.lastIndexOf(" ")))}...`;
  }

  function lowerFirst(text) {
    const clean = String(text || "").trim();
    return clean.charAt(0).toLowerCase() + clean.slice(1);
  }

  function titleCase(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\b[a-z]/g, (char) => char.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeKey(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < String(text).length; i += 1) {
      hash ^= String(text).charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let value = typeof seed === "number" ? seed >>> 0 : hashString(seed);
    return function random() {
      value += 0x6d2b79f5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, rng) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  return {
    SAMPLE_TEXT,
    createSession,
    generateRound,
    gradeRound,
    _private: {
      splitSentences,
      buildFact,
      tokenize,
      hashString,
    },
  };
});
