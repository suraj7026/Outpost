const files = {
  readme: {
    name: 'README.md', added: true,
    html: `<h1>BitChat protocol research</h1>
<p class="lead">A short overview of how BitChat moves messages, protects their contents, and behaves when peers go offline.</p>
<h2 id="overview">Overview</h2>
<p>BitChat combines nearby Bluetooth communication with internet-based relays. The transport available determines how far a message can travel.</p>
<h2 id="transports">Transports</h2>
<table><thead><tr><th>Transport</th><th>How it works</th></tr></thead>
<tbody><tr><td>Bluetooth LE mesh</td><td>Nearby devices relay messages without an internet connection.</td></tr>
<tr><td>Nostr relays</td><td>Internet-connected clients use relays for broader reach.</td></tr></tbody></table>
<h2 id="message-delivery">Message delivery</h2>
<ul><li>Nearby peers can relay messages across the local mesh.</li>
<li>Store-and-forward paths can hold messages until peers reconnect.</li>
<li>Delivery is <strong>best-effort, not guaranteed.</strong></li></ul>
<h2 id="security-privacy">Security &amp; privacy</h2>
<blockquote>Encrypted does not mean anonymous.</blockquote>
<p>Encryption protects message contents, but metadata and observable Bluetooth activity can reveal relationships between devices.</p>
<p>Forward secrecy depends on the message path. Verify the current upstream security documentation before relying on privacy guarantees.</p>
<h2 id="sources">Sources</h2>
<ul><li><a href="https://github.com/permissionlesstech/bitchat" data-source>Upstream repository</a></li>
<li>Protocol whitepaper</li><li>Source-routing documentation</li><li>Privacy assessment</li></ul>
<p class="small muted">Sample research content for the Outpost workspace design. Verify technical claims against current upstream documentation.</p>`,
    markdown: `# BitChat protocol research

A short overview of how BitChat moves messages, protects their contents, and behaves when peers go offline.

## Overview

BitChat combines nearby Bluetooth communication with internet-based relays. The transport available determines how far a message can travel.

## Transports

| Transport | How it works |
| --- | --- |
| Bluetooth LE mesh | Nearby devices relay messages without an internet connection. |
| Nostr relays | Internet-connected clients use relays for broader reach. |

## Message delivery

- Nearby peers can relay messages across the local mesh.
- Store-and-forward paths can hold messages until peers reconnect.
- Delivery is **best-effort, not guaranteed.**

## Security & privacy

> Encrypted does not mean anonymous.

Encryption protects message contents, but metadata and observable Bluetooth activity can reveal relationships between devices.

Forward secrecy depends on the message path. Verify the current upstream security documentation before relying on privacy guarantees.

## Sources

- [Upstream repository](https://github.com/permissionlesstech/bitchat)
- Protocol whitepaper
- Source-routing documentation
- Privacy assessment

Sample research content for the Outpost workspace design. Verify technical claims against current upstream documentation.
`
  },
  sources: {
    name: 'sources.md', added: false,
    html: `<h1>Research sources</h1>
<p class="lead">Working list of references for the BitChat overview.</p>
<ul><li><a href="https://github.com/permissionlesstech/bitchat" data-source>Upstream repository</a></li>
<li>Protocol whitepaper</li><li>Source-routing documentation</li><li>Privacy assessment</li></ul>
<h2 id="verification-checklist">Verification checklist</h2>
<ul><li>Check the current protocol version.</li><li>Distinguish transport behavior from privacy guarantees.</li><li>Note which claims depend on implementation details.</li></ul>`,
    markdown: `# Research sources

Working list of references for the BitChat overview.

- [Upstream repository](https://github.com/permissionlesstech/bitchat)
- Protocol whitepaper
- Source-routing documentation
- Privacy assessment

## Verification checklist

- Check the current protocol version.
- Distinguish transport behavior from privacy guarantees.
- Note which claims depend on implementation details.
`
  },
  notes: {
    name: 'notes.md', added: false,
    html: `<h1>Research notes</h1>
<p class="lead">Keep delivery and privacy assumptions separate in the final overview.</p>
<h2 id="open-questions">Open questions</h2>
<ul><li>What happens when a recipient stays offline?</li><li>Which message paths provide forward secrecy?</li><li>What metadata can nearby observers see?</li></ul>`,
    markdown: `# Research notes

Keep delivery and privacy assumptions separate in the final overview.

## Open questions

- What happens when a recipient stays offline?
- Which message paths provide forward secrecy?
- What metadata can nearby observers see?
`
  }
};
