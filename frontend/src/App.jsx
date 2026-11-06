
import React, { useEffect, useState } from "react";

const API = "";

export default function App() {
  const [messages, setMessages] = useState([]);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sessionChecked, setSessionChecked] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [lastNotificationId, setLastNotificationId] = useState("");

  // Load the Gmail inbox and validate the current session.
  const load = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API}/api/inbox`, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        setUser(null);
        setMessages([]);
        setError(data.error || "Please sign in with Google.");
        return;
      }

      if (!response.ok) {
        throw new Error(
          data.error || `Unable to load inbox (${response.status})`
        );
      }

      setUser(data.user || null);
      setMessages(data.messages || []);
      setError("");
    } catch (err) {
      setError(err.message || "Unable to connect to the CRM backend.");
    } finally {
      setLoading(false);
      setSessionChecked(true);
    }
  };

  // Check the session whenever the application initially loads.
  useEffect(() => {
    load();
  }, []);

  // Poll the notification endpoint; Gmail push itself is received by the backend.
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    const checkNotifications = async () => {
      try {
        const r = await fetch(`${API}/api/notifications`, { credentials: "include" });
        if (!r.ok) return;
        const data = await r.json();
        if (!active) return;
        const items = data.notifications || [];
        setNotifications(items);
        const newest = items[0]?.notificationId || "";
        if (newest && lastNotificationId && newest !== lastNotificationId) {
          await load();
        }
        if (newest) setLastNotificationId(newest);
      } catch (err) {
        // Keep the inbox usable if notification polling is temporarily unavailable.
      }
    };
    checkNotifications();
    const timer = setInterval(checkNotifications, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [user, lastNotificationId]);

  // Start Google OAuth through CloudFront.
  const login = () => {
    window.location.href = `${API}/api/oauth/google`;
  };

  async function sendEmail(e) {
    e.preventDefault();
    setSendStatus("Sending…");
    try {
      const r = await fetch(`${API}/api/send`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body: emailBody })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Email sending failed");
      setSendStatus("Email sent. Replies will appear in your Gmail inbox; refresh to check.");
      setTo(""); setSubject(""); setEmailBody("");
    } catch (err) { setSendStatus(err.message); }
  }

  // Sign out and remove the server-side session.
  const logout = async () => {
    try {
      await fetch(`${API}/api/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      console.error("Logout request failed");
    }

    setUser(null);
    setMessages([]);
    setNotifications([]);
    setLastNotificationId("");
    setError("");
    window.location.href = "/";
  };

  if (!sessionChecked && loading) {
    return (
      <main className="shell">
        <header>
          <div>
            <div className="eyebrow">CRM INTEGRATION</div>
            <h1>Google Inbox</h1>
            <p>Gmail inbox with email sending and push notifications</p>
          </div>
        </header>

        <section className="panel">
          <p>Checking your Google session…</p>
        </section>

        <footer>Google OAuth · Gmail API · AWS</footer>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <div>
          <div className="eyebrow">CRM INTEGRATION</div>
          <h1>Google Inbox</h1>
          <p>Gmail inbox with email sending and push notifications</p>
        </div>

        {user && (
          <button className="secondary" onClick={logout}>
            Sign out
          </button>
        )}
      </header>

      {!user ? (
        <section className="panel login">
          <div className="mailicon">✉</div>

          <h2>Connect your Google inbox</h2>

          <p>Sign in with Google and authorize Gmail inbox reading and email sending.</p>

          {error && (
            <p className="error">
              {error}
            </p>
          )}

          <button onClick={login}>
            Continue with Google
          </button>

          <small>Requested Gmail permissions: read inbox and send email.</small>
        </section>
      ) : (
        <section className="panel">
          <div className="toolbar">
            <div>
              <strong>{user.email}</strong>
              <p>Your latest inbox messages</p>
            </div>

            <button className="secondary" onClick={load} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <form className="composer" onSubmit={sendEmail}>
            <h2>Compose email</h2>
            <input type="email" required placeholder="Colleague email address" value={to} onChange={e=>setTo(e.target.value)} />
            <input required maxLength="200" placeholder="Subject" value={subject} onChange={e=>setSubject(e.target.value)} />
            <textarea required maxLength="10000" rows="5" placeholder="Write your message…" value={emailBody} onChange={e=>setEmailBody(e.target.value)} />
            <button type="submit">Send email</button>
            {sendStatus && <p role="status">{sendStatus}</p>}
          </form>

          <div className="notification-heading">
            <h2>Inbox / reply notifications</h2>
            <p>Gmail push notifications arrive through Google Pub/Sub. This page checks for new notifications every 30 seconds.</p>
          </div>

          {notifications.length > 0 && (
            <div className="notification-list">
              {notifications.map((item) => (
                <article className="message notification" key={item.notificationId}>
                  <div className="sender">New Gmail message · {item.from || "Unknown sender"}</div>
                  <div className="subject">{item.subject || "(No subject)"}</div>
                  <div className="snippet">{item.snippet}</div>
                  <time>{item.date || item.createdAt}</time>
                </article>
              ))}
            </div>
          )}

          {loading ? (
            <p>Loading inbox…</p>
          ) : error ? (
            <p className="error">{error}</p>
          ) : messages.length === 0 ? (
            <p>Your inbox is empty.</p>
          ) : (
            messages.map((message) => (
              <article className="message" key={message.id}>
                <div className="sender">{message.from}</div>

                <div className="subject">
                  {message.subject || "(No subject)"}
                </div>

                <div className="snippet">{message.snippet}</div>

                <time>{message.date}</time>
              </article>
            ))
          )}
        </section>
      )}

      <footer>Google OAuth · Gmail API · AWS</footer>
    </main>
  );
}
