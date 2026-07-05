// Netlify Function: (1) reads photographed handwritten intake/InBody forms into
// structured JSON via Claude vision, (2) generates warm follow-up email + text.
// Requires ANTHROPIC_API_KEY env var in Netlify site settings. Key never reaches the browser.

const INTAKE_SCHEMA_PROMPT = `You are reading a photo of a handwritten personal training client intake form.
Extract into this exact JSON shape. Use empty string "" (or empty array []) for anything absent or illegible.
Never guess at illegible handwriting — leave it blank rather than invent a value.

{
  "name": "", "phone": "", "email": "",
  "age": "", "heightIn": "", "gender": "", "occupation": "", "activityLevel": "",
  "medical": "", "medications": "", "stressLevel": "", "sleepHours": "",
  "goals": [], "scaleVsLook": "", "loseInches": "", "inchesWhere": "",
  "whyImportant": "", "currentPlan": "", "preventedBefore": "", "lifeChange": "",
  "happySixMonths": "", "sixMonthChange": "", "fitnessLevel": "",
  "typicalEating": "", "nutritionRating": "", "eatOutFreq": "", "followGuide": "", "wantCustom": "",
  "monthlyInvestment": "", "prevTrainer": "", "prevTrainerExp": "", "availability": "",
  "commitment": "", "struggles": [], "readyToday": ""
}

Rules:
- "heightIn": total inches as a plain number string. Convert 5'7" -> "67". If shown in cm, divide by 2.54 and round.
- "gender": exactly "male", "female", or "".
- "activityLevel": exactly "active", "sedentary", or "".
- "goals": array of AT MOST 2, using EXACTLY these option strings when circled/marked: "Lose Weight","Gain Weight","More Muscle / Tone Up","Improve Strength","More Energy / Endurance","Manage Health Conditions","Manage Anxiety & Stress","Improve Flexibility".
- "scaleVsLook": "scale" if Number on the Scale is marked, "look" if How I Look & Feel is marked, else "".
- Yes/No fields ("loseInches","happySixMonths","followGuide","wantCustom","prevTrainer"): exactly "yes", "no", or "".
- 1-5 ratings ("stressLevel","fitnessLevel","nutritionRating","commitment","readyToday"): the circled digit as a string.
- "struggles": array using EXACTLY: "Time","Money","Commitment","Education","Motivation","Nutrition".
- Respond with ONLY the raw JSON object. No markdown fences, no commentary.`;

const INBODY_SCHEMA_PROMPT = `You are reading a photo of a handwritten or printed InBody body composition scan / goal roadmap sheet.
Extract into this exact JSON shape. Use empty string "" for anything absent or illegible.
Never guess at smudged numbers — leave blank rather than invent.

{
  "heightIn": "",
  "weightLbs": "", "bodyFatPct": "", "muscleMassLbs": "", "inbodyScore": "",
  "weightGoal": "", "bodyFatGoal": "", "timelineWeeks": ""
}

Rules:
- All numbers as plain number strings, no units or % signs.
- "heightIn": total inches. Convert 5'7" -> "67". If height is printed in cm, divide by 2.54 and round.
- Weights: if printed in kg, multiply by 2.2046, round to 1 decimal.
- Respond with ONLY the raw JSON object. No markdown fences, no commentary.`;

function followupPrompt(client) {
  return `You are Ernest Joseph, an elite personal trainer and Personal Training Leader at Life Time.
A prospective client just finished a consultation with you but did not sign up today (decision: ${client.decision || "undecided"}).
Write a warm, zero-pressure follow-up. Voice: direct, human, encouraging — no fluff, no guilt, no hard sell. Reference their specific "why" and one concrete detail from the session so it feels personal, not templated.

Client summary:
- Name: ${client.name || "there"}
- Goals: ${client.goals || "not stated"}
- Their why: ${client.why || "not stated"}
- What blocked them before: ${client.preventedBefore || "not stated"}
- How life changes when they succeed: ${client.lifeChange || "not stated"}
- Movement screen notes: ${client.assessmentNotes || "none"}
- Body comp: ${client.currentStats || "not measured"}
- Program discussed: ${client.recommendation || "not discussed"}

Respond with ONLY this raw JSON object (no markdown fences, no commentary):
{
  "emailSubject": "",
  "emailBody": "",
  "textMessage": ""
}

Rules:
- emailBody: max 130 words. One clear, low-pressure call to action (reply or a quick call). Sign off exactly:
Ernest Joseph
Personal Training Leader · Life Time
- textMessage: max 45 words and MUST begin exactly: "Hey ${(client.name || "").split(" ")[0] || "there"} — this is Ernest, your trainer from Life Time."
- No emojis. Plain text only, use \\n for line breaks in emailBody.`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY. Add it in Netlify site settings → Environment variables." }) };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { image, mediaType, formType, client } = payload;

  let messages;
  if (formType === "followup") {
    if (!client) return { statusCode: 400, body: JSON.stringify({ error: "Missing client summary" }) };
    messages = [{ role: "user", content: [{ type: "text", text: followupPrompt(client) }] }];
  } else {
    if (!image || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: "Missing image data" }) };
    const promptText = formType === "inbody" ? INBODY_SCHEMA_PROMPT : INTAKE_SCHEMA_PROMPT;
    messages = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: promptText },
      ],
    }];
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1500, messages }),
    });
    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: "Claude API error: " + errText }) };
    }
    const data = await response.json();
    const rawText = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    let extracted;
    try { extracted = JSON.parse(cleaned); }
    catch (e) { return { statusCode: 502, body: JSON.stringify({ error: "Could not parse response", raw: rawText }) }; }
    return { statusCode: 200, body: JSON.stringify({ extracted }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Request failed: " + e.message }) };
  }
};
