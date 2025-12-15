/*import React, { useState } from "react";
import { Link } from "react-router-dom";
import "./index.css";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setSent(true); // mock success
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>Reset Password</h2>
        <p className="auth-subtitle">
          We’ll send you reset instructions
        </p>

        {!sent ? (
          <form onSubmit={handleSubmit}>
            <label>Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />

            <button className="btn auth-btn">
              Send Reset Link
            </button>
          </form>
        ) : (
          <div className="auth-success">
            ✔ Password reset link sent to <b>{email}</b>
          </div>
        )}

        <p className="auth-footer">
          Back to <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
*/
import React, { useState } from "react";
import { Link } from "react-router-dom";
import "./index.css";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setSent(true);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>Reset Password</h2>
        <p className="auth-subtitle">Reset link will be sent</p>

        {!sent ? (
          <form onSubmit={handleSubmit}>
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <button className="btn auth-btn">Send Reset Link</button>
          </form>
        ) : (
          <div className="auth-success">
            ✔ Reset link sent to {email}
          </div>
        )}

        <p className="auth-footer">
          Back to <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
