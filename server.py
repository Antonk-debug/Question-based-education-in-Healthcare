import json
import mimetypes
import os
import pathlib
import random
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parent
IS_HOSTED_RUNTIME = bool(os.environ.get("PORT") or os.environ.get("RENDER"))
PORT = int(os.environ.get("PORT") or ("10000" if os.environ.get("RENDER") else "4173"))


def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()
HOST = os.environ.get("HOST") or ("0.0.0.0" if IS_HOSTED_RUNTIME else "127.0.0.1")
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite-preview"
DEFAULT_GEMINI_MODELS = f"{DEFAULT_GEMINI_MODEL},gemini-2.5-flash,gemini-2.5-flash-lite"
CONFIGURED_GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip()
GEMINI_MODEL = DEFAULT_GEMINI_MODEL if CONFIGURED_GEMINI_MODEL in {"", "gemini-2.5-flash"} else CONFIGURED_GEMINI_MODEL
CONFIGURED_GEMINI_MODELS = os.environ.get("GEMINI_MODELS", "").strip()
if CONFIGURED_GEMINI_MODELS in {"", "gemini-2.5-flash,gemini-2.5-flash-lite"}:
    CONFIGURED_GEMINI_MODELS = DEFAULT_GEMINI_MODELS if GEMINI_MODEL == DEFAULT_GEMINI_MODEL else f"{GEMINI_MODEL},gemini-2.5-flash,gemini-2.5-flash-lite"
GEMINI_MODELS = [
    model.strip()
    for model in CONFIGURED_GEMINI_MODELS.split(",")
    if model.strip()
]


SYSTEM_PROMPT = " ".join(
    [
        "You are an expert teacher and assessment designer.",
        "Generate exactly the requested number of multiple-choice questions from the supplied educational text.",
        "Detect the dominant language of the supplied source text.",
        "Write every learner-facing string in the same language as the source text, including coverageSummary, area, skillTag, question, options, explanation, sourceQuote, and mapTopic.",
        "Keep JSON property names in English exactly as specified, but do not default the quiz content to English unless the source text is English.",
        "If the source text mixes languages, use the dominant language while preserving names, technical terms, and quoted phrases as they appear in the source.",
        "Each question must have exactly five answer options.",
        "correctIndex must be a zero-based number from 0 to 4.",
        "Each question must have exactly one correct option.",
        "The correct answer must not be identical to the question.",
        "All four incorrect options must be clearly wrong, incomplete, or unsupported by the source text.",
        "Do not include any distractor that could reasonably be accepted as another correct answer.",
        "Questions should be tricky but fair: distractors should be plausible misconceptions based on the text, not silly or obviously unrelated.",
        "Use only the supplied source text. Do not add outside facts.",
        "Avoid all-of-the-above, none-of-the-above, joke answers, and answer options that are duplicated or nearly duplicated.",
        "For adaptive rounds, focus most questions on the weak areas and mistakes provided.",
        "Include the requested number as questionCount in the JSON response.",
        'Return only valid JSON matching this shape: {"coverageSummary":"string","questionCount":5,"questions":[{"area":"string","skillTag":"string","question":"string","options":["string","string","string","string","string"],"correctIndex":0}]}',
    ]
)


class QuizHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        if urllib.parse.urlparse(self.path).path in {"/api/config", "/api/verify-access", "/api/generate-quiz"}:
            self.send_response(204)
            self.send_cors_headers()
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self):
        request_path = urllib.parse.urlparse(self.path).path
        if request_path == "/api/verify-access":
            try:
                self.handle_verify_access()
            except Exception as error:
                print(f"Server error: {error}")
                self.send_json(500, {"error": "Unexpected server error"})
            return

        if request_path != "/api/generate-quiz":
            self.send_json(404, {"error": "Not found"})
            return

        try:
            self.handle_generate_quiz()
        except Exception as error:
            print(f"Server error: {error}")
            self.send_json(500, {"error": "Unexpected server error"})

    def do_GET(self):
        request_path = urllib.parse.urlparse(self.path).path
        if request_path == "/api/config":
            self.send_json(200, {"accessRequired": bool(ACCESS_CODE)})
            return

        if request_path == "/":
            request_path = "/Adaptive Quiz Studio.html" if (ROOT / "Adaptive Quiz Studio.html").exists() else "/index.html"

        file_path = (ROOT / request_path.lstrip("/")).resolve()
        try:
            file_path.relative_to(ROOT)
        except ValueError:
            self.send_error(403)
            return

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_verify_access(self):
        body = self.read_json_body()
        if self.is_access_authorized(body):
            self.send_json(200, {"ok": True})
            return
        self.send_json(401, {"error": "Access code is incorrect"})

    def handle_generate_quiz(self):
        body = self.read_json_body()
        if not self.is_access_authorized(body):
            self.send_json(401, {"error": "Enter the access code to use this quiz app"})
            return

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            self.send_json(500, {"error": "Gemini API key is missing on the backend"})
            return

        text = str(body.get("text", "")).strip()
        if len(text) < 40:
            self.send_json(400, {"error": "Paste a little more educational text first"})
            return

        prompt = "\n\n".join(
            [
                SYSTEM_PROMPT,
                build_user_prompt(body),
            ]
        )

        request_body = json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.35,
                    "responseMimeType": "application/json",
                },
            }
        ).encode("utf-8")

        try:
            payload, model_used = call_gemini_with_fallbacks(api_key, request_body)
        except GeminiRequestError as error:
            self.send_json(error.status_code, {"error": error.message})
            return

        output_text = extract_gemini_text(payload)
        if not output_text:
            self.send_json(502, {"error": "Gemini did not return quiz text"})
            return

        try:
            parsed = parse_json_from_text(output_text)
            normalized = normalize_ai_round(parsed, int(body.get("roundSize", 5) or 5), int(body.get("roundIndex", 1) or 1))
        except Exception as error:
            print(f"Repairing Gemini quiz response: {error}")
            try:
                parsed = repair_quiz_payload(parsed if "parsed" in locals() else {}, text, int(body.get("roundSize", 5) or 5))
                normalized = normalize_ai_round(parsed, int(body.get("roundSize", 5) or 5), int(body.get("roundIndex", 1) or 1))
            except Exception as repair_error:
                self.send_json(502, {"error": f"Gemini returned invalid quiz JSON: {repair_error}"})
                return

        normalized["modelUsed"] = model_used
        self.send_json(200, normalized)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 1_200_000:
            raise ValueError("Request body is too large")
        data = self.rfile.read(length).decode("utf-8")
        return json.loads(data) if data else {}

    def is_access_authorized(self, body):
        if not ACCESS_CODE:
            return True
        provided = self.headers.get("X-Access-Code", "") or str(body.get("accessCode", ""))
        return provided.strip() == ACCESS_CODE

    def send_json(self, status_code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Access-Code")

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")


class GeminiRequestError(Exception):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def call_gemini_with_fallbacks(api_key, request_body):
    tried = []
    last_error = None

    for index, model_name in enumerate(unique_model_list(GEMINI_MODELS)):
        tried.append(model_name)
        try:
            return call_gemini_model(api_key, model_name, request_body), model_name
        except GeminiRequestError as error:
            last_error = error
            if index < len(unique_model_list(GEMINI_MODELS)) - 1 and is_retryable_gemini_error(error):
                print(f"Gemini model {model_name} failed temporarily: {error.message}. Trying fallback model.")
                continue
            break

    tried_text = ", ".join(tried)
    if last_error:
      raise GeminiRequestError(last_error.status_code, f"{last_error.message} Tried models: {tried_text}.")
    raise GeminiRequestError(502, f"No Gemini models were available. Tried models: {tried_text}.")


def call_gemini_model(api_key, model_name, request_body):
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model_name, safe="")
        + ":generateContent?key="
        + urllib.parse.quote(api_key, safe="")
    )
    request = urllib.request.Request(
        url,
        data=request_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise GeminiRequestError(error.code, extract_error_message(detail, error.code))
    except urllib.error.URLError as error:
        raise GeminiRequestError(502, f"Could not reach Gemini: {error.reason}")


def unique_model_list(models):
    seen = set()
    unique = []
    for model_name in models:
        key = model_name.lower()
        if key not in seen:
            seen.add(key)
            unique.append(model_name)
    return unique


def is_retryable_gemini_error(error):
    message = error.message.lower()
    return (
        error.status_code in {429, 500, 502, 503, 504}
        or "high demand" in message
        or "temporarily" in message
        or "unavailable" in message
    )


def build_user_prompt(settings):
    weak_areas = settings.get("weakAreas") if isinstance(settings.get("weakAreas"), list) else []
    mistakes = settings.get("previousMistakes") if isinstance(settings.get("previousMistakes"), list) else []
    mistake_text = "No previous mistakes."
    if mistakes:
        lines = []
        for index, item in enumerate(mistakes[-8:], start=1):
            lines.append(
                f"{index}. Area: {item.get('area', '')}. Question: {item.get('prompt', '')}. "
                f"Correct: {item.get('correct', '')}. Chosen: {item.get('chosen', 'No answer')}."
            )
        mistake_text = "\n".join(lines)

    return "\n\n".join(
        [
            f"Round: {settings.get('roundIndex', 1)}",
            f"Number of questions to generate: {settings.get('roundSize', 5)}",
            f"Weak areas: {', '.join(weak_areas) if weak_areas else 'None yet'}",
            "Previous mistakes:",
            mistake_text,
            "Source text:",
            str(settings.get("text", "")),
            "Output language: use the same dominant language as the source text for all visible quiz content.",
            "Generate the next quiz round now.",
        ]
    )


def extract_gemini_text(payload):
    candidates = payload.get("candidates") if isinstance(payload, dict) else []
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(part.get("text", "") for part in parts).strip()


def parse_json_from_text(text):
    clean = text.strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        unfenced = re.sub(r"^```(?:json)?\s*", "", clean, flags=re.IGNORECASE)
        unfenced = re.sub(r"\s*```$", "", unfenced).strip()
        try:
            return json.loads(unfenced)
        except json.JSONDecodeError:
            start = unfenced.find("{")
            end = unfenced.rfind("}")
            if start >= 0 and end > start:
                return json.loads(unfenced[start : end + 1])
            raise


def normalize_ai_round(payload, expected_count, round_index):
    if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
        raise ValueError("The AI response had the wrong quiz shape")

    questions = []
    for index, question in enumerate(payload["questions"][:expected_count]):
        raw_options = [clean_text(option) for option in question.get("options", []) if clean_text(option)][:5]
        correct_index = int(question.get("correctIndex", -1))
        if len(raw_options) != 5 or correct_index < 0 or correct_index > 4:
            raise ValueError("A question did not have exactly five valid options")

        correct_text = raw_options[correct_index]
        options = unique_by_key(raw_options)
        normalized_correct_index = next(
            (i for i, option in enumerate(options) if normalize_key(option) == normalize_key(correct_text)),
            -1,
        )

        if len(options) != 5 or normalized_correct_index < 0:
            raise ValueError("The AI returned duplicate options or an invalid answer index")

        if has_near_duplicate_correct_option(options, normalized_correct_index):
            raise ValueError("The AI returned another option too similar to the correct answer")

        randomized_options = randomize_options(options, normalized_correct_index)
        prompt = clean_text(question.get("question", ""))
        question_id = f"ai-{round_index}-{index}-{abs(hash(prompt))}"
        questions.append(
            {
                "id": question_id,
                "area": clean_text(question.get("area")) or "Source concept",
                "type": "ai",
                "prompt": prompt,
                "options": [
                    {
                        "id": "answer" if option["is_correct"] else f"ai-option-{option_index}-{abs(hash(option['text']))}",
                        "text": option["text"],
                    }
                    for option_index, option in enumerate(randomized_options)
                ],
                "answerId": "answer",
                "explanation": clean_text(question.get("explanation")) or "The correct answer follows directly from the source text.",
                "source": clean_text(question.get("sourceQuote")) or "Source text",
                "skillTag": clean_text(question.get("skillTag")) or "Comprehension",
                "mapTopic": clean_map_topic(question.get("mapTopic") or question.get("skillTag") or question.get("area") or f"Q{index + 1}"),
            }
        )

    if len(questions) != expected_count:
        raise ValueError(f"The AI did not return exactly {expected_count} questions")

    return {"coverageSummary": clean_text(payload.get("coverageSummary", "")), "questionCount": expected_count, "questions": questions}


def repair_quiz_payload(payload, source_text, expected_count):
    if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
        raise ValueError("The AI response had the wrong quiz shape")

    repaired_questions = []
    source_terms = extract_source_terms(source_text)

    for index, question in enumerate(payload["questions"]):
        if len(repaired_questions) >= expected_count:
            break

        prompt = clean_text(question.get("question", ""))
        raw_options = [clean_text(option) for option in question.get("options", []) if clean_text(option)]
        if not prompt or len(raw_options) < 1:
            continue

        correct_index = safe_int(question.get("correctIndex"), 0)
        if correct_index < 0 or correct_index >= len(raw_options):
            correct_index = 0

        correct_option = raw_options[correct_index]
        options = unique_by_key([correct_option] + raw_options)
        filler_index = 1
        while len(options) < 5:
            filler = build_filler_option(question, source_terms, filler_index)
            filler_index += 1
            if normalize_key(filler) not in {normalize_key(option) for option in options}:
                options.append(filler)

        repaired_questions.append(
            {
                "area": clean_text(question.get("area")) or f"Source concept {index + 1}",
                "skillTag": clean_text(question.get("skillTag")) or "Comprehension",
                "mapTopic": clean_map_topic(question.get("mapTopic") or question.get("skillTag") or question.get("area") or f"Q{index + 1}"),
                "question": prompt,
                "options": options[:5],
                "correctIndex": 0,
                "explanation": clean_text(question.get("explanation")) or "The correct answer follows directly from the source text.",
                "sourceQuote": clean_text(question.get("sourceQuote")) or source_text[:180],
            }
        )

    while len(repaired_questions) < expected_count:
        index = len(repaired_questions)
        repaired_questions.append(build_fallback_question(index, source_text, source_terms))

    if len(repaired_questions) != expected_count:
        raise ValueError(f"Could not repair the AI response into exactly {expected_count} questions")

    return {
        "coverageSummary": clean_text(payload.get("coverageSummary")) or "Generated from the source text.",
        "questionCount": expected_count,
        "questions": repaired_questions,
    }


def build_fallback_question(index, source_text, source_terms):
    term = source_terms[index % len(source_terms)] if source_terms else f"source concept {index + 1}"
    return {
        "area": term.title(),
        "skillTag": "Comprehension",
        "mapTopic": clean_map_topic(term),
        "question": f"Which answer is best supported by the source text about {term}?",
        "options": [
            f"The source directly supports the key point about {term}",
            f"A plausible but unsupported claim about {term}",
            f"A reversed relationship involving {term}",
            "A broader statement than the source text supports",
            "A detail from the source that does not answer this question",
        ],
        "correctIndex": 0,
        "explanation": "The correct answer is the option most directly supported by the supplied source text.",
        "sourceQuote": source_text[:180],
    }


def extract_source_terms(source_text):
    words = re.findall(r"[A-Za-z][A-Za-z'-]{3,}", source_text)
    stop_words = {
        "about",
        "after",
        "because",
        "before",
        "between",
        "could",
        "during",
        "every",
        "from",
        "have",
        "into",
        "more",
        "most",
        "other",
        "that",
        "their",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "where",
        "which",
        "while",
        "with",
        "would",
    }
    terms = []
    seen = set()
    for word in words:
        key = word.lower()
        if key in stop_words or key in seen:
            continue
        seen.add(key)
        terms.append(word)
    return terms[:12]


def build_filler_option(question, source_terms, index):
    area = clean_text(question.get("area")) or "the topic"
    term = source_terms[(index - 1) % len(source_terms)] if source_terms else area
    templates = [
        f"A plausible but unsupported claim about {term}",
        f"A reversed relationship involving {area}",
        f"A broader statement than the source text supports",
        f"A detail from the source that does not answer this question",
        f"A partly true statement that misses the key condition",
    ]
    return templates[(index - 1) % len(templates)]


def safe_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def unique_by_key(items):
    seen = set()
    unique = []
    for item in items:
        key = normalize_key(item)
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def randomize_options(options, correct_index):
    randomized = [
        {
            "text": clean_text(option),
            "is_correct": index == correct_index,
        }
        for index, option in enumerate(options)
    ]
    random.shuffle(randomized)
    return randomized


def has_near_duplicate_correct_option(options, correct_index):
    correct = clean_text(options[correct_index])
    return any(
        index != correct_index and are_options_too_similar(correct, option)
        for index, option in enumerate(options)
    )


def are_options_too_similar(first, second):
    first_key = normalize_key(first)
    second_key = normalize_key(second)
    if not first_key or not second_key:
        return False
    if first_key == second_key:
        return True
    if len(first_key) > 25 and len(second_key) > 25 and (first_key in second_key or second_key in first_key):
        return True

    first_tokens = meaningful_tokens(first_key)
    second_tokens = meaningful_tokens(second_key)
    if len(first_tokens) < 4 or len(second_tokens) < 4:
        return False

    overlap = len(set(first_tokens) & set(second_tokens))
    union = len(set(first_tokens) | set(second_tokens))
    return overlap / min(len(first_tokens), len(second_tokens)) >= 0.86 and overlap / union >= 0.72


def meaningful_tokens(key):
    stop_words = {"the", "and", "that", "this", "with", "from", "into", "about", "because", "when", "while", "which"}
    return [token for token in key.split() if len(token) > 2 and token not in stop_words]


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_map_topic(value):
    words = clean_text(value).split()
    return " ".join(words[:3]) if words else "Topic"


def normalize_key(value):
    normalized = unicodedata.normalize("NFKC", str(value or "").lower())
    parts = []
    previous_space = False
    for char in normalized:
        if char.isalnum():
            parts.append(char)
            previous_space = False
        elif not previous_space:
            parts.append(" ")
            previous_space = True
    return "".join(parts).strip()


def extract_error_message(detail, status_code):
    try:
        payload = json.loads(detail)
        return payload.get("error", {}).get("message") or f"Gemini request failed with status {status_code}"
    except json.JSONDecodeError:
        return f"Gemini request failed with status {status_code}"


def main():
    display_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    print(f"Adaptive Quiz Studio is running at http://{display_host}:{PORT}/")
    print("Keep this window open while using the app.")
    ThreadingHTTPServer((HOST, PORT), QuizHandler).serve_forever()


if __name__ == "__main__":
    main()
