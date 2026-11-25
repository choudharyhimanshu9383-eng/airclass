import React, { useState } from "react";

const PORTALS = {
  teacher: {
    label: "Teacher",
    icon: "✦",
    title: "Teach with your hands free",
    description:
      "Present a lesson, move through slides, and guide quick knowledge checks.",
  },
  student: {
    label: "Student",
    icon: "↗",
    title: "Learn at your own pace",
    description:
      "Follow the lesson, answer simple questions, and see feedback right away.",
  },
};

export default function PortalEntry({ onEnter }) {
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [className, setClassName] = useState("");

  function submit(event) {
    event.preventDefault();
    if (!name.trim()) return;
    onEnter({ role, name: name.trim(), className: className.trim() });
  }

  return (
    <main className="portal-entry">
      <header className="entry-brand">
        <div className="logo">AC</div>
        <div>
          <strong>AirClass</strong>
          <span> A calmer way to teach and learn</span>
        </div>
      </header>

      <section className="entry-hero">
        <div className="entry-eyebrow">WELCOME TO YOUR CLASSROOM</div>
        <h1>Learning that moves with you.</h1>
        <p>
          Choose your portal to get started. Use the mouse or try the simple
          webcam gestures—your choice.
        </p>
      </section>

      <section className="portal-grid" aria-label="Choose a portal">
        {Object.entries(PORTALS).map(([key, portal]) => (
          <button
            className={`portal-choice${role === key ? " active" : ""}`}
            key={key}
            onClick={() => setRole(key)}
            type="button"
          >
            <span className="portal-icon">{portal.icon}</span>
            <span className="portal-choice-label">{portal.label} portal</span>
            <span className="portal-choice-title">{portal.title}</span>
            <span className="portal-choice-copy">{portal.description}</span>
          </button>
        ))}
      </section>

      {role && (
        <form className="entry-form" onSubmit={submit}>
          <div>
            <span className="entry-eyebrow">{PORTALS[role].label} SIGN IN</span>
            <h2>Let’s get your space ready.</h2>
          </div>
          <label className="field">
            Your name
            <input
              autoComplete="name"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder={role === "teacher" ? "e.g. Ms. Rivera" : "e.g. Sam"}
              required
              type="text"
              value={name}
            />
          </label>
          <label className="field">
            {role === "teacher" ? "Class or subject" : "Class code (optional)"}
            <input
              onChange={(event) => setClassName(event.target.value)}
              placeholder={
                role === "teacher" ? "e.g. Biology 101" : "e.g. BIO101"
              }
              type="text"
              value={className}
            />
          </label>
          <button className="primary entry-submit" type="submit">
            Enter {PORTALS[role].label.toLowerCase()} portal <span>→</span>
          </button>
          <p className="entry-note">
            Demo sign-in uses a name only. No account or password is sent or
            stored.
          </p>
        </form>
      )}

      <section className="entry-help">
        <div>
          <span className="help-number">01</span>
          <div>
            <strong>Move the pointer</strong>
            <p>Move your index fingertip slowly in front of the camera.</p>
          </div>
        </div>
        <div>
          <span className="help-number">02</span>
          <div>
            <strong>Select or advance</strong>
            <p>Pinch thumb + index to select; thumb + middle to advance.</p>
          </div>
        </div>
        <div>
          <span className="help-number">03</span>
          <div>
            <strong>Mouse works too</strong>
            <p>Every key action also has a visible button to click.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
