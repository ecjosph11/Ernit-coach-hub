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

If it fits naturally, you may offer Program Design Only ($250/month — custom program + one monthly check-in, no in-person sessions) in the EMAIL as a lower-commitment way to start. Never make it the headline — it's a door-opener, not the pitch. Do not mention it in the text message.

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

function workoutBCPrompt(c) {
  return `You are Ernest Joseph, an elite ISSA-certified personal trainer. The client's Workout A for the current training phase is below, as the coach wrote it. Do two jobs:

JOB 1 — Parse WORKOUT A verbatim into structured rows. Do NOT redesign it: keep the coach's exercises, order, sets, reps, tempo, and rest exactly as written. Fill only genuinely missing values with phase-appropriate defaults and keep any existing coaching cues.

JOB 2 — Build complementary Workouts B and C for the same phase.

Framework — each workout covers these 7 movement patterns: squat, unilateral lower body, hip hinge, horizontal pull, vertical push, horizontal push, anti-extension core.
Rules:
- Match Workout A's difficulty level, session length, and equipment style.
- Use DIFFERENT exercise variations for the same patterns — complementary, never repeats of Workout A.
- Movement screen results are below. If the phase is Phase 1 (Neuromuscular Development & Corrective), build the listed corrective drills directly into Workouts B and C as warm-up or accessory work, and bias main-lift variations around the flagged faults. In later phases keep the corrective bias in exercise selection but prioritize the phase goal.
- Keep rep ranges consistent with the phase goal.
- tempo: 4 digits like "2011". rest: like "60s". sets/reps as strings.
- Every exercise gets a one-line coaching note in a direct, no-BS voice.

Phase: ${c.phase || "Phase 1"}
Client goals: ${c.goals || "not stated"}
Movement screen grades: ${c.screenGrades || "not assessed"}
Flagged faults + prescribed correctives: ${c.faults || "none"}

WORKOUT A (verbatim):
${c.workoutA}

Respond with ONLY this raw JSON object (no markdown fences, no commentary):
{"workoutA":[{"name":"","sets":"","reps":"","tempo":"","rest":"","note":""}],"workoutB":[{"name":"","sets":"","reps":"","tempo":"","rest":"","note":""}],"workoutC":[{"name":"","sets":"","reps":"","tempo":"","rest":"","note":""}]}`;
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
  if (formType === "workoutBC") {
    if (!client || !client.workoutA) return { statusCode: 400, body: JSON.stringify({ error: "Missing Workout A text" }) };
    messages = [{ role: "user", content: [{ type: "text", text: workoutBCPrompt(client) }] }];
  } else if (formType === "followup") {
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
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: formType === "workoutBC" ? 3000 : 1500, messages }),
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
