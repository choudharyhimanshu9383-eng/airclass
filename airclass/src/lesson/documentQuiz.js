import { unzipSync, strFromU8 } from "fflate";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const STOP_WORDS = new Set(
  "about after again against all also another any are because been before being between both but can could did does doing down during each few for from further had has have having here how into its itself just more most other our out over same she should some such than that the their them then there these they this those through under until very was were what when where which while who will with would your".split(
    " ",
  ),
);

export async function extractPdfText(file) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const document = await loadingTask.promise;
  const pages = [];
  const pageCount = document.numPages;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .filter(Boolean)
          .join(" "),
      );
    }
  } finally {
    await loadingTask.destroy();
  }
  return { text: pages.join("\n"), pages, pageCount };
}

export async function extractPptxSlides(file) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const slideFiles = Object.keys(archive)
    .map((name) => {
      const match = /(?:^|\/)slide(\d+)\.xml$/i.exec(name);
      return match ? { name, number: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);

  if (slideFiles.length === 0) {
    throw new Error("No readable slides were found in this PowerPoint file.");
  }

  return slideFiles.map(({ name }) => {
    const xml = new DOMParser().parseFromString(
      strFromU8(archive[name]),
      "application/xml",
    );
    if (xml.querySelector("parsererror")) {
      throw new Error(`Could not read slide ${name}.`);
    }
    return Array.from(xml.getElementsByTagNameNS("*", "t"))
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(" ");
  });
}

function createVocabulary(text) {
  const frequencies = new Map();
  for (const word of text.match(/[A-Za-z][A-Za-z'-]*/g) || []) {
    const term = word.toLowerCase();
    if (term.length >= 4 && !STOP_WORDS.has(term)) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
  }
  const allTerms = [...frequencies.keys()].sort(
    (a, b) => frequencies.get(b) - frequencies.get(a) || a.localeCompare(b),
  );
  return { frequencies, allTerms };
}

function buildDocumentQuiz(
  text,
  limit,
  vocabulary = createVocabulary(text),
  answerOffset = 0,
) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences =
    normalized.match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()) || [];
  const usableSentences = sentences.filter((sentence) => {
    const words = sentence.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    return words.length >= 5 && sentence.length <= 180;
  });

  const { frequencies, allTerms } = vocabulary;
  if (allTerms.length < 4) return null;

  const questions = [];
  const usedAnswers = new Set();
  for (const sentence of usableSentences) {
    const sentenceTerms = (sentence.match(/[A-Za-z][A-Za-z'-]*/g) || []).map(
      (word) => word.toLowerCase(),
    );
    const answer = sentenceTerms
      .filter(
        (term) =>
          frequencies.has(term) &&
          !usedAnswers.has(term) &&
          term.length >= 4 &&
          !STOP_WORDS.has(term),
      )
      .sort(
        (a, b) => frequencies.get(b) - frequencies.get(a) || a.localeCompare(b),
      )[0];
    if (!answer) continue;

    const distractors = allTerms
      .filter((term) => term !== answer && !sentenceTerms.includes(term))
      .slice(0, 3);
    for (const term of allTerms) {
      if (distractors.length >= 3) break;
      if (term !== answer && !distractors.includes(term)) distractors.push(term);
    }
    if (distractors.length < 3) continue;

    const escapedAnswer = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const question = sentence.replace(
      new RegExp(`\\b${escapedAnswer}\\b`, "i"),
      "_____",
    );
    const correctIndex = (questions.length + answerOffset) % 4;
    const options = [...distractors];
    options.splice(correctIndex, 0, answer);
    questions.push({
      question: `Complete the lesson sentence: ${question}`,
      options,
      answer: correctIndex,
    });
    usedAnswers.add(answer);
    if (questions.length >= limit) break;
  }

  return questions;
}

function throwInsufficientTextError() {
  throw new Error(
    "There is not enough readable text to create a multiple-choice quiz. Use a text-based PDF or PPTX with more lesson content.",
  );
}

export function createDocumentQuiz(text, limit = 4) {
  const questions = buildDocumentQuiz(text, limit);
  if (questions === null) throwInsufficientTextError();
  if (questions.length === 0) {
    throw new Error(
      "Could not find a clear sentence for a quiz question. Try a document with selectable text and full sentences.",
    );
  }
  return questions;
}

export function createDocumentQuizBySections(sections) {
  const vocabulary = createVocabulary(sections.join("\n"));
  const questions = sections.flatMap((text, sourceIndex) =>
    (
      buildDocumentQuiz(text, 1, vocabulary, sourceIndex) || []
    ).map((question) => ({ ...question, sourceIndex })),
  );
  if (questions.length === 0) throwInsufficientTextError();
  return questions;
}
