# A little helper for finding a place to live

LSE student accommodation disappears fast. This project watches the official booking portal for you and your friends, and pings you the moment a room shows up.

It is meant to be shared. One person runs it; everyone who needs a hall can get the alert.

---

## What it does

**Looks for rooms.** Every few minutes it opens the LSE accommodation site the same way you would, and checks whether anything is available.

**Tells you.** When something appears, it sends a message to the addresses you choose. At the end of the day it can send a short “here is how today went” note.

**Lets you pause.** A small password-protected page shows the latest result, lets you start or stop the watcher, and is there if the university login asks for an Authenticator tap or an email code.

That is the whole product: keep an eye on halls so you do not have to refresh the page at 2am.

---

## Who this is for

Anyone looking for LSE halls — you, a flatmate, a friend who is still on the waitlist. The code in this repository is a blank starter. It does not come with anyone else’s mailbox, university login, or hosting account. The person who runs it (or their coding agent) fills that in once.

---

## Setting it up

1. **Fork** this repository into your own GitHub account. Do not set it up on the original.
2. Give your agent the **fork** and point it at **[agent-instructions.md](agent-instructions.md)**.

That file is the setup manual: fork first, then what to ask you for, where secrets live, and how to think about the project. Do not paste passwords or mailbox details into this README.

---

## After it is running

You should get:

- an alert when a residence actually has a room
- a daily recap so you know the watcher is still alive
- a tiny dashboard if you want to look at status or hit pause

If a check asks for Microsoft Authenticator or an email code, open the dashboard while that check is still running and finish the prompt there.

---

## A note on sharing

This is a tool for friends, not a hosted service with a public mailbox. Fork it, then whoever operates the fork uses **their** university login and **their** mail. Never reuse another person’s secrets or accounts.
