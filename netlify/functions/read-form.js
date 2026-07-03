// Netlify Function: reads a photographed handwritten intake or InBody form
// and extracts it into structured JSON using Claude's vision API.
// Requires ANTHROPIC_API_KEY set as an environment variable in Netlify site settings.
// Never expose the key to the browser — this function is the only place it's used.

const INTAKE_SCHEMA_PROMPT = `You are reading a photo of a handwritten fitness client intake form.
Extract the information into this exact JSON shape, using empty strings "" for anything not present or illegible.
Do not guess at illegible handwriting — leave it blank rather than invent a value.

{
  "name": "",
  "phone": "",
  "email": "",
  "age": "",
  "heightIn": "",
  "gender": "",
  "occupation": "",
  "goal1": "",
  "goal2": "",
  "scaleVsLook": "",
  "inchesGoal": "",
  "motivation": "",
  "nutritionLifestyle": "",
  "trainingHistory": "",
  "healthWellness": "",
  "selfAssessment": ""
}

Rules:
- "heightIn" must be a plain number of total inches (e.g. 5'5" becomes "65"), or "" if not given.
- "gender" must be exactly "male", "female", or "" if unclear.
- "scaleVsLook" must be exactly "scale", "look", "both", or "" if unclear.
- Respond with ONLY the raw JSON object. No markdown fences, no commentary, no explanation.`;

const INBODY_SCHEMA_PROMPT = `You are reading a photo of a handwritten or printed InBody body composition scan / roadmap sheet.
Extract the information into this exact JSON shape, using empty strings "" for anything not present or illegible.
Do not guess at illegible handwriting or smudged numbers — leave it blank rather than invent a value.

{
  "weightLbs": "",
  "bodyFatPct": "",
  "muscleMassLbs": "",
  "inbodyScore": "",
  "weightGoal": "",
  "bodyFatGoal": "",
  "timelineWeeks": ""
}

Rules:
- All numeric fields should be plain numbers as strings (e.g. "162.4"), no units, no percent signs.
- Respond with ONLY the raw JSON object. No markdown fences, no commentary, no explanation.`;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY. Add it in Netlify site settings → Environment variables." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { image, mediaType, formType } = payload;
  if (!image || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing image data" }) };
  }

  const promptText = formType === "inbody" ? INBODY_SCHEMA_PROMPT : INTAKE_SCHEMA_PROMPT;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: promptText },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: "Claude API error: " + errText }) };
    }

    const data = await response.json();
    const rawText = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();

    // Strip markdown fences if the model added them anyway
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: "Could not parse form data from response", raw: rawText }) };
    }

    return { statusCode: 200, body: JSON.stringify({ extracted }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Request failed: " + e.message }) };
  }
};
