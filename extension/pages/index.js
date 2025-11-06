import Head from "next/head"
import React, { useEffect, useState, useRef } from "react"
import styles from "../styles/Home.module.css"
import SessionManager from "../src/modules/auth"

export default function Home() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)
  const [mgr, setMgr] = useState(null);

  useEffect(() => {
    // Create SessionManager and query current user (uses chrome.storage)
    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        if (mgr) return; // already initialized

        const sessionManager = new SessionManager();
        sessionManager.getCurrentUser().then((u) => { if (u) setUser(u); }).catch(() => { });

        setMgr(sessionManager);
      } catch (err) {
        console.warn('SessionManager getCurrentUser failed', err)
      }
    }
  }, [])

  function startSignIn() {
    if (typeof chrome === 'undefined' || !chrome.identity) {
      console.warn('chrome.identity not available; sign-in only works in extension context')
      return
    }

    setLoading(true)

    mgr.signInWithGoogleIdentity('popup sign-in').then((session) => {
      setLoading(false)
      setErrorMsg(null)
      console.log('Sign-in successful', session)
      if (session && session.user) {
        setUser(session.user);
      } else if (session && session.access_token) {
        // fallback if user info saved separately
        mgr.getCurrentUser().then((u) => { if (u) setUser(u); }).catch(() => { })
      }
    }).catch((err) => {
      setLoading(false)
      const msg = err && err.message ? err.message : String(err)
      setErrorMsg(msg)
      console.error('Sign-in failed', err)
    })
  }

  function signOut() {
    if (typeof chrome === 'undefined' || !chrome.storage) return
    mgr.signOut().then(() => setUser(null)).catch(() => setUser(null))
  }

  return (
    <div className={styles.container}>
      <Head>
        <title>Friday Clone — Sidebar</title>
        <meta name="description" content="Credits sidebar UI" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <aside className={styles.panel} role="complementary">
        <div className={styles.section}>
          <h2 className={styles.heading}>Credits</h2>
          <div className={styles.creditRow}>
            <div className={styles.creditLabel}>Credits</div>
            <div className={styles.creditValue}>927/1000</div>
          </div>

          <div className={styles.progressTrack} aria-hidden>
            <div className={styles.progressFill} style={{ width: '92.7%' }} />
          </div>
        </div>

        <div className={styles.section}>
          <h3 className={styles.subheading}>Accounts</h3>

          <div className={styles.accountRow}>
            {/* <div className={styles.avatar}>{user ? (user.name ? user.name[0].toUpperCase() : 'U') : 'R'}</div> */}
            <div className={styles.accountInfo}>
              <div className={styles.accountEmail}>{user ? (user.email || user.id) : 'Not signed in'}</div>
            </div>
            <div className={styles.check} style={{ visibility: user ? 'visible' : 'hidden' }}>✓</div>
          </div>

          <div className={styles.divider} />

          <button className={styles.action}>
            <span className={styles.icon}>⬆️</span>
            <span>Upgrade Credits Plan</span>
          </button>

          <button className={styles.action} onClick={startSignIn} disabled={loading}>
            <span className={styles.icon}>➕</span>
            <span>{loading ? 'Signing in...' : (user ? 'Signed in' : 'Sign in with Google')}</span>
          </button>

          {errorMsg && (
            <div style={{ marginTop: 12, color: '#f88', fontSize: 13 }}>
              <strong>Error:</strong> {errorMsg}
            </div>
          )}

          <button className={styles.action} onClick={signOut}>
            <span className={styles.icon}>↪️</span>
            <span>Logout</span>
          </button>
        </div>
      </aside>
    </div>
  )
}
