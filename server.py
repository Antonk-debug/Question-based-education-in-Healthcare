import hashlib
import json
import mimetypes
import os
import pathlib
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parent
IS_HOSTED_RUNTIME = bool(os.environ.get("PORT") or os.environ.get("RENDER"))
PORT = int(os.environ.get("PORT") or ("10000" if os.environ.get("RENDER") else "4173"))

QBL_QUESTION_COUNT = 3
DEFAULT_QBL_COURSE_DESCRIPTION = (
    "A short, specialized continuing education course for registered dietitians in Sweden. The course focuses on Personalised Nutrition Care, integrating nutrigenomics, microbiome analysis, and individualized metabolic profiling with Swedish dietary guidelines such as NNR 2023."
)
DEFAULT_QBL_LEARNING_GOAL = (
    "Apply personalised nutrition principles to create individualized dietary interventions while still considering evidence-based Swedish dietary guidelines."
)
DEFAULT_QBL_SELECTED_SKILL = (
    "Analyzing patient continuous glucose monitor, CGM, data alongside subjective lifestyle logs to identify highly individualized glycemic triggers that do not align with standard population-level carbohydrate guidelines."
)
DEFAULT_QBL_SOURCE_TEXT = "\n".join(
    [
        "A short, specialized continuing education course for registered dietitians in Sweden. The course focuses on \"Personalised Nutrition Care,\" updating clinical skills to integrate nutrigenomics, microbiome analysis, and individualized metabolic profiling alongside Nordic dietary guidelines (e.g., NNR 2023) to create highly tailored patient interventions.",
        "",
        "Skill context:",
        "Analyzing patient continuous glucose monitor (CGM) data alongside subjective lifestyle logs to identify highly individualized glycemic triggers that do not align with population-level carbohydrate guidelines, interpreted within the patient\u2019s broader metabolic health picture and used to inform, not override, tailored dietary prescriptions.",
    ]
)


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
GEMINI_MODELS = [model.strip() for model in CONFIGURED_GEMINI_MODELS.split(",") if model.strip()]


# QBL system prompt is defined here for local Python mode. It mirrors the browser/Node prompt contract.
SYSTEM_PROMPT = " ".join(
    [
        "You are an expert Question-Based Learning designer for professional and continuing education.",
        "Question-Based Learning is for learning through answering questions, not for evaluation. If the learner already knows all answers from the start, there is nothing to learn from the course.",
        "Generate QBL-style learning content for one selected skill at a time.",
        "Use the supplied course description, learning goal, selected skill, and source text as the complete educational context.",
        "Do not assume a dietetics, healthcare, CGM, or nutrition topic unless those details appear in the supplied fields.",
        "Create a short but informative knowledge bank about the selected skill, based mainly on the source text.",
        "Create exactly three multiple-choice QBL questions of varying difficulty: easy, medium, and hard.",
        "Questions must fit the target group and subject area described in the course description.",
        "Questions must encourage understanding, application, or analysis, not simple memorization.",
        "Do not create simple lookup, recall, or definition questions.",
        "Each question must be easy to understand, unambiguous, and focused on one common misconception.",
        "Each question must have exactly four answer options with ids A, B, C, and D.",
        "Every option must be short, clear, plausible, and contextually appropriate.",
        "Each incorrect option must be a realistic distractor tied directly to the targeted misconception.",
        "Every option must include unique tailored feedback.",
        "Feedback for the correct option must begin with exactly 'Correct.'.",
        "Feedback for incorrect options must begin with exactly 'Incorrect.'.",
        "Incorrect feedback must be short, constructive, and guide the learner without revealing, naming, quoting, or describing the correct answer.",
        "Never write 'The correct answer is' or similar wording in incorrect feedback.",
        "Return only valid JSON. Do not wrap it in markdown.",
        'Return this exact JSON shape: {"course":"string","learningGoal":"string","skill":"string","knowledgeBank":"string","questionCount":3,"questions":[{"difficulty":"easy","targetedMisconception":"string","question":"string","options":[{"id":"A","text":"string","isCorrect":true,"feedback":"Correct. string"},{"id":"B","text":"string","isCorrect":false,"feedback":"Incorrect. string"}]}]}.',
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
        try:
            if request_path == "/api/verify-access":
                self.handle_verify_access()
                return
            if request_path == "/api/generate-quiz":
                self.handle_generate_quiz()
                return
            self.send_json(404, {"error": "Not found"})
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

        # The four QBL setup fields arrive here from the browser before they are inserted into the AI prompt.
        course_description = str(body.get("courseDescription", "")).strip()
        learning_goal = str(body.get("learningGoal", "")).strip()
        selected_skill = str(body.get("selectedSkill") or body.get("skill") or "").strip()
        text = str(body.get("text") or body.get("sourceText") or "").strip()
        if not course_description or not learning_goal or not selected_skill or not text:
            self.send_json(400, {"error": "Complete the course description, learning goal, selected skill, and source text first"})
            return
        if len(text) < 40:
            self.send_json(400, {"error": "Add a little more source text first"})
            return

        generation_settings = dict(body)
        generation_settings.update(
            {
                "courseDescription": course_description,
                "learningGoal": learning_goal,
                "selectedSkill": selected_skill,
                "text": text,
            }
        )

        prompt = "\n\n".join([SYSTEM_PROMPT, build_user_prompt(generation_settings)])
        request_body = json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.35, "responseMimeType": "application/json"},
            }
        ).encode("utf-8")

        try:
            payload, model_used = call_gemini_with_fallbacks(api_key, request_body)
        except GeminiRequestError as error:
            self.send_json(error.status_code, {"error": error.message})
            return

        output_text = extract_gemini_text(payload)
        if not output_text:
            self.send_json(502, {"error": "Gemini did not return QBL text"})
            return

        try:
            # The AI JSON response is parsed here, then validated into the app-ready QBL shape.
            parsed = parse_json_from_text(output_text)
            normalized = normalize_qbl_round(parsed, int(body.get("roundIndex", 1) or 1), generation_settings)
            normalized["modelUsed"] = model_used
            self.send_json(200, normalized)
        except Exception as error:
            self.send_json(502, {"error": f"Gemini returned invalid QBL JSON: {error}"})

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
    models = unique_model_list(GEMINI_MODELS)

    for index, model_name in enumerate(models):
        tried.append(model_name)
        try:
            return call_gemini_model(api_key, model_name, request_body), model_name
        except GeminiRequestError as error:
            last_error = error
            if index < len(models) - 1 and is_retryable_gemini_error(error):
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
    request = urllib.request.Request(url, data=request_body, headers={"Content-Type": "application/json"}, method="POST")

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
    return error.status_code in {429, 500, 502, 503, 504} or "high demand" in message or "temporarily" in message or "unavailable" in message


def get_qbl_context(settings):
    return {
        "courseDescription": clean_text(settings.get("courseDescription") or settings.get("course") or DEFAULT_QBL_COURSE_DESCRIPTION),
        "learningGoal": clean_text(settings.get("learningGoal") or DEFAULT_QBL_LEARNING_GOAL),
        "selectedSkill": clean_text(settings.get("selectedSkill") or settings.get("skill") or DEFAULT_QBL_SELECTED_SKILL),
        "sourceText": clean_text(settings.get("sourceText") or settings.get("text") or DEFAULT_QBL_SOURCE_TEXT),
    }


def build_user_prompt(settings):
    qbl_context = get_qbl_context(settings)
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
            # Course description, learning goal, selected skill, and source text are inserted into the QBL prompt here.
            "Course description:",
            qbl_context["courseDescription"],
            "Learning goal:",
            qbl_context["learningGoal"],
            "Selected skill:",
            qbl_context["selectedSkill"],
            f"Round: {settings.get('roundIndex', 1)}",
            f"Number of QBL questions to generate: {QBL_QUESTION_COUNT}",
            f"Weak areas from earlier answers: {', '.join(weak_areas) if weak_areas else 'None yet'}",
            "Previous learner mistakes:",
            mistake_text,
            "Source text:",
            qbl_context["sourceText"],
            "Output language: English unless the course description, learning goal, selected skill, or source text is clearly written in another language. Preserve technical terms, guideline names, and proper nouns from the supplied context.",
            "Generate the QBL knowledge bank and three questions now.",
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


def normalize_qbl_round(payload, round_index, context=None):
    qbl_context = get_qbl_context(context or {})
    if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
        raise ValueError("The AI response had the wrong QBL shape")
    if len(payload["questions"]) != QBL_QUESTION_COUNT:
        raise ValueError(f"The AI must return exactly {QBL_QUESTION_COUNT} QBL questions")

    learning_goal = clean_text(payload.get("learningGoal")) or normalize_string_array(payload.get("learningGoals"), [qbl_context["learningGoal"]])[0]
    skill = clean_text(payload.get("skill")) or normalize_string_array(payload.get("skills"), [qbl_context["selectedSkill"]])[0]
    questions = [normalize_qbl_question(question, index, round_index, qbl_context) for index, question in enumerate(payload["questions"])]
    return {
        "course": clean_course(payload.get("course"), qbl_context["courseDescription"]),
        "learningGoal": learning_goal,
        "skill": skill,
        "learningGoals": normalize_string_array(payload.get("learningGoals") or [payload.get("learningGoal")], [learning_goal]),
        "skills": normalize_string_array(payload.get("skills") or [payload.get("skill")], [skill]),
        "knowledgeBank": validate_knowledge_bank(payload.get("knowledgeBank")),
        "coverageSummary": clean_text(payload.get("coverageSummary") or payload.get("knowledgeBank") or ""),
        "questionCount": QBL_QUESTION_COUNT,
        "questions": questions,
    }

def normalize_qbl_question(question, index, round_index, context=None):
    qbl_context = get_qbl_context(context or {})
    if not isinstance(question, dict):
        raise ValueError(f"QBL question {index + 1} is missing")

    prompt = clean_text(question.get("question") or question.get("prompt"))
    if not prompt:
        raise ValueError(f"QBL question {index + 1} is missing question text")
    if is_lookup_style_question(prompt):
        raise ValueError(f"QBL question {index + 1} looks like a lookup or definition question")

    raw_options = question.get("options") if isinstance(question.get("options"), list) else []
    raw_options = raw_options[:4]
    if len(raw_options) < 3:
        raise ValueError(f"QBL question {index + 1} needs at least three answer options")

    answer_id = clean_text(question.get("answerId"))
    options = [normalize_qbl_option(option, option_index, answer_id) for option_index, option in enumerate(raw_options)]
    if len(unique_by_key([option["text"] for option in options])) != len(options):
        raise ValueError(f"QBL question {index + 1} has duplicate answer options")

    correct_options = [option for option in options if option["isCorrect"]]
    if len(correct_options) != 1:
        raise ValueError(f"QBL question {index + 1} must have exactly one correct answer")

    correct_option = correct_options[0]
    correct_index = next(i for i, option in enumerate(options) if option["id"] == correct_option["id"])
    if has_near_duplicate_correct_option([option["text"] for option in options], correct_index):
        raise ValueError(f"QBL question {index + 1} has an answer option too similar to the correct option")

    for option in options:
        validate_qbl_feedback(option, correct_option["text"], index)

    difficulty = normalize_difficulty(question.get("difficulty"), index)
    targeted_misconception = clean_text(question.get("targetedMisconception"))
    if not targeted_misconception:
        raise ValueError(f"QBL question {index + 1} needs a targeted misconception")

    return {
        "id": clean_text(question.get("id")) or f"qbl-{round_index or 1}-{index}-{stable_hash(prompt)}",
        "area": clean_text(question.get("area")) or clean_map_topic(qbl_context["selectedSkill"] or qbl_context["courseDescription"]),
        "type": "qbl",
        "prompt": prompt,
        "options": options,
        "answerId": correct_option["id"],
        "explanation": correct_option["feedback"],
        "source": "QBL knowledge bank",
        "skillTag": clean_text(question.get("skillTag")) or qbl_context["selectedSkill"],
        "mapTopic": clean_map_topic(question.get("mapTopic") or targeted_misconception or difficulty),
        "difficulty": difficulty,
        "targetedMisconception": targeted_misconception,
    }

def normalize_qbl_option(option, option_index, answer_id):
    if not isinstance(option, dict):
        raise ValueError("Each QBL answer option must be an object with id, text, isCorrect, and feedback")
    fallback_id = chr(65 + option_index)
    option_id = clean_text(option.get("id")) or fallback_id
    is_correct = option.get("isCorrect") if isinstance(option.get("isCorrect"), bool) else bool(answer_id and option_id == answer_id)
    return {
        "id": option_id,
        "text": clean_text(option.get("text")),
        "isCorrect": is_correct,
        "feedback": clean_text(option.get("feedback")),
    }


def validate_qbl_feedback(option, correct_text, question_index):
    if not option["text"]:
        raise ValueError(f"QBL question {question_index + 1} has an empty answer option")
    if not option["feedback"]:
        raise ValueError(f"QBL question {question_index + 1} has an answer option without feedback")
    if option["isCorrect"]:
        if not option["feedback"].startswith("Correct."):
            raise ValueError(f"Correct feedback in QBL question {question_index + 1} must begin with Correct.")
        return
    if not option["feedback"].startswith("Incorrect."):
        raise ValueError(f"Incorrect feedback in QBL question {question_index + 1} must begin with Incorrect.")
    if reveals_correct_answer(option["feedback"], correct_text):
        raise ValueError(f"Incorrect feedback in QBL question {question_index + 1} reveals the correct answer")


def reveals_correct_answer(feedback, correct_text):
    feedback_key = normalize_key(feedback)
    correct_key = normalize_key(correct_text)
    if re.search(r"\b(correct|right) answer\b", feedback_key) or re.search(r"\banswer is\b", feedback_key):
        return True
    return len(correct_key) > 12 and correct_key in feedback_key


def is_lookup_style_question(question_text):
    return bool(re.match(r"^(define\b|which option best defines|which .*definition|how is .*defined|what does .*mean|what is the definition)\b", clean_text(question_text), flags=re.IGNORECASE))


def normalize_difficulty(value, index):
    difficulty = clean_text(value).lower()
    if difficulty in {"easy", "medium", "hard"}:
        return difficulty
    return ["easy", "medium", "hard"][index] if index < 3 else "medium"


def validate_knowledge_bank(value):
    knowledge_bank = clean_text(value)
    if not knowledge_bank:
        raise ValueError("The QBL response needs a knowledgeBank")
    return knowledge_bank


def clean_course(value, fallback):
    fallback_course = clean_text(fallback) or "QBL activity"
    if isinstance(value, str):
        return clean_text(value) or fallback_course
    if isinstance(value, dict):
        return clean_text(value.get("title") or value.get("name") or value.get("description")) or fallback_course
    return fallback_course


def normalize_string_array(value, fallback):
    if not isinstance(value, list):
        return list(fallback)
    items = unique_by_key([clean_text(item) for item in value if clean_text(item)])
    return items or list(fallback)


def unique_by_key(items):
    seen = set()
    unique = []
    for item in items:
        key = normalize_key(item)
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def has_near_duplicate_correct_option(options, correct_index):
    correct = clean_text(options[correct_index])
    return any(index != correct_index and are_options_too_similar(correct, option) for index, option in enumerate(options))


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


def stable_hash(value):
    return hashlib.sha1(str(value).encode("utf-8")).hexdigest()[:10]


def extract_error_message(detail, status_code):
    try:
        payload = json.loads(detail)
        return payload.get("error", {}).get("message") or f"Gemini request failed with status {status_code}"
    except json.JSONDecodeError:
        return f"Gemini request failed with status {status_code}"


def main():
    display_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    print(f"Question Based Learning is running at http://{display_host}:{PORT}/")
    print("Keep this window open while using the app.")
    ThreadingHTTPServer((HOST, PORT), QuizHandler).serve_forever()


if __name__ == "__main__":
    main()