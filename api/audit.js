
import { GoogleGenAI, Type } from "@google/genai";
import { Brand } from "../types";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Tạo nội dung RAG (Retrieval-Augmented Generation) trực tiếp từ client.
 */
export async function generateContentDirect(payload: {
  brand: Brand;
  topic: string;
  platform: string;
  language: string;
  context: string;
  systemInstruction: string;
}) {
  const ai = getAI();
  const { brand, topic, platform, language, context, systemInstruction } = payload;

  const prompt = `
Viết bài cho: ${platform}
Chủ đề: ${topic}
Ngôn ngữ: ${language}

Dựa trên kho tri thức sau:
${context || "Sử dụng thông tin mặc định từ Profile thương hiệu."}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.7,
      topP: 0.95,
    },
  });

  return {
    result: response.text || "AI không thể tạo nội dung.",
    citations: context ? ["Knowledge Base"] : []
  };
}

/**
 * Kiểm tra giọng văn thương hiệu (Audit) trực tiếp từ client.
 */
export async function auditContentDirect(payload: {
  brand: Brand;
  text: string;
  prompt: string;
}) {
  const ai = getAI();
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Nội dung cần kiểm tra: \n${payload.text}`,
    config: {
      systemInstruction: payload.prompt,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          overall_score: { type: Type.NUMBER },
          summary: { type: Type.STRING },
          identified_issues: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                issue_type: { type: Type.STRING },
                problematic_text: { type: Type.STRING },
                reason: { type: Type.STRING },
                severity: { type: Type.STRING },
                suggestion: { type: Type.STRING }
              }
            }
          },
          rewritten_text: { type: Type.STRING }
        },
        required: ["overall_score", "summary", "identified_issues"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    return { error: "Failed to parse AI response", raw: response.text };
  }
}

/**
 * Phân tích nội dung (từ Website hoặc File) để tạo Profile tự động.
 */
export async function analyzeBrandDirect(content: string) {
  const ai = getAI();
  
  const prompt = `
Phân tích nội dung sau và trích xuất TOÀN BỘ thông tin thương hiệu chi tiết dưới định dạng JSON.
Cố gắng tìm kiếm Mission, Vision, USP, và các quy tắc viết (Do/Don't words).

Nội dung:
${content}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          legal_name: { type: Type.STRING },
          industry: { type: Type.STRING },
          slogan: { type: Type.STRING },
          tagline: { type: Type.STRING },
          mission: { type: Type.STRING },
          vision: { type: Type.STRING },
          usp: { type: Type.ARRAY, items: { type: Type.STRING } },
          core_values: { type: Type.ARRAY, items: { type: Type.STRING } },
          brand_personality: { type: Type.ARRAY, items: { type: Type.STRING } },
          tone_of_voice: { type: Type.STRING },
          do_words: { type: Type.ARRAY, items: { type: Type.STRING } },
          dont_words: { type: Type.ARRAY, items: { type: Type.STRING } },
          style_rules: { type: Type.STRING },
          primary_color: { type: Type.STRING },
          summary: { type: Type.STRING }
        }
      }
    }
  });

  return JSON.parse(response.text || "{}");
}
