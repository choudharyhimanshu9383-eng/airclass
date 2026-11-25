import React, { useState } from "react";

export const MCQ = {
  question: "What gas do plants absorb from the air during photosynthesis?",
  options: ["Oxygen", "Nitrogen", "Carbon dioxide", "Hydrogen"],
  answer: 2,
};

export const MCQS = [
  MCQ,
  {
    question: "Which part of a plant absorbs sunlight?",
    options: ["Roots", "Leaf", "Flower", "Stem"],
    answer: 1,
  },
  {
    question: "What do plants release during photosynthesis?",
    options: ["Carbon dioxide", "Oxygen", "Nitrogen", "Helium"],
    answer: 1,
  },
  {
    question: "Which structure carries water through a plant?",
    options: ["Stomata", "Xylem", "Leaf", "Petal"],
    answer: 1,
  },
];

export const DRAG = {
  title: "Drag each label onto the part of the plant it describes.",
  labels: ["Absorbs sunlight", "Takes in CO₂", "Carries water"],
  zones: [
    { id: "z0", correct: 0, name: "Leaf surface" },
    { id: "z1", correct: 1, name: "Stomata (underside)" },
    { id: "z2", correct: 2, name: "Xylem vessels" },
  ],
};

export function TaskSelect({
  questions = MCQS,
  questionIndexes,
  selected,
  targetIndex,
  onSelect,
}) {
  return (
    <div>
      <h3>Task 1 — Answer the questions (index pinch)</h3>
      {questions.map((question, questionIndex) => {
        const selectionIndex =
          questionIndexes?.[questionIndex] ?? questionIndex;
        return (
          <div
            className="mcq-block"
            key={`${selectionIndex}-${question.question}`}
          >
            <p>
              <strong>
                {selectionIndex + 1}. {question.question}
              </strong>
            </p>
            <div className="opt-grid">
              {question.options.map((option, optionIndex) => (
                <button
                  key={option}
                  data-air-option={optionIndex}
                  data-air-question={selectionIndex}
                  className={
                    "option" +
                    (selected?.[selectionIndex] === optionIndex
                      ? " selected"
                      : "") +
                    (selected?.[selectionIndex] === optionIndex &&
                    question.answer === optionIndex
                      ? " correct"
                      : "") +
                    (selected?.[selectionIndex] === optionIndex &&
                    question.answer !== optionIndex
                      ? " wrong"
                      : "") +
                    (selected?.[selectionIndex] != null &&
                    question.answer === optionIndex &&
                    selected?.[selectionIndex] !== optionIndex
                      ? " reveal-correct"
                      : "") +
                    (targetIndex === optionIndex ? " target" : "")
                  }
                  onClick={() => onSelect?.(selectionIndex, optionIndex)}
                >
                  {String.fromCharCode(65 + optionIndex)}. {option}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TaskScroll({ onNext }) {
  return (
    <div>
      <h3>Task 2 — Scroll to the next question (middle pinch)</h3>
      <p>
        You read this question with your eyes. Use a{" "}
        <strong>middle finger pinch</strong> to scroll to the next section
        below.
      </p>
      <div className="diagram">
        📷 How many legs does an insect have? — this question is just for
        scrolling practice.
      </div>
      <button className="primary next-section" type="button" onClick={onNext}>
        ↓ Go to the next section
      </button>
    </div>
  );
}

export function TaskDrag({
  placed,
  results,
  targetLabel,
  targetZone,
  dragging,
}) {
  return (
    <div>
      <h3>
        Task 3 — Drag a label onto the diagram (index pinch grab → release)
      </h3>
      <p>{DRAG.title}</p>
      <div className="drag-labels">
        {DRAG.labels.map((l, i) => (
          <button
            key={l}
            data-air-label={i}
            className={
              "drag-label" +
              (placed[i] != null ? " ghost" : "") +
              (targetLabel === i ? " target" : "")
            }
            style={
              targetLabel === i && dragging
                ? {
                    position: "relative",
                    left: dragging.dx - dragging.anchorLeft,
                    top: dragging.dy - dragging.anchorTop,
                  }
                : undefined
            }
            disabled={placed[i] != null && !dragging}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="diagram">
        🌱 Photosynthesis diagram — drop the labels on the matching parts below.
      </div>
      <div className="drop-zones">
        {DRAG.zones.map((z, i) => {
          const placedIdx = Object.entries(placed).find(
            ([, zi]) => zi === i,
          )?.[0];
          const res = results[i];
          return (
            <div
              key={z.id}
              data-air-zone={i}
              className={
                "drop-zone" +
                (targetZone === i ? " target" : "") +
                (res === true ? " correct" : res === false ? " wrong" : "")
              }
            >
              <div>
                {res === true && <span className="tick">✓ </span>}
                {res === false && <span className="tick">✗ </span>}
                <div>{z.name}</div>
                {placedIdx != null && <small>→ {DRAG.labels[placedIdx]}</small>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
