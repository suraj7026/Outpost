# Feature ownership map

Every feature in the current v3 catalogue is owned once. The latest owner decisions replace older desktop, mode, payment and APNs assumptions; see [architecture](00-system-architecture.md).

| Feature | Name | Owning module | Stage |
|---|---|---|---|
| TASK-01 | Outcome-based requests | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-02 | One task across tools | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-03 | Visible working plan | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-04 | Durable run lifecycle | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-05 | Steering and queued follow-ups | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-06 | Pause, cancel, and resume | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-07 | Independent conversations | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| TASK-08 | Task branches and retries | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | E |
| TASK-09 | Long-running missions | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | E |
| TASK-10 | Evidence-based handoff | [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | C |
| FS-01 | Personal home directory | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-02 | Full file operations | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-03 | Fast discovery | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-04 | Reliable transfers | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-05 | Structured artifacts | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-06 | Version and restore | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-07 | Shared and isolated folders | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| FS-08 | Storage services and connectors | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | E |
| FS-09 | File intake pipeline | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | E |
| FS-10 | Storage lifecycle | [02 Server files and artifacts](02-filesystem-and-artifacts.md) | C |
| RUN-01 | Noninteractive shell | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-02 | Agent-only interactive PTY | [03 Agent commands and processes](03-commands-and-processes.md) | E |
| RUN-03 | Background processes | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-04 | Resource supervision | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-05 | Cancellation propagation | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-06 | Structured command tools | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-07 | Remote SSH operations | [03 Agent commands and processes](03-commands-and-processes.md) | E |
| RUN-08 | Headless application automation | [03 Agent commands and processes](03-commands-and-processes.md) | E |
| RUN-09 | Environment profiles | [03 Agent commands and processes](03-commands-and-processes.md) | C |
| RUN-10 | Reusable procedures | [03 Agent commands and processes](03-commands-and-processes.md) | E |
| SYS-01 | Machine inventory | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | C |
| SYS-02 | Approved sudo | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | C |
| SYS-03 | Root maintenance lease | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | E |
| SYS-04 | Service management | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | C |
| SYS-05 | Package and runtime maintenance | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | C |
| SYS-06 | Users and permissions | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | E |
| SYS-07 | Network administration | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | E |
| SYS-08 | Reboot-aware work | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | E |
| SYS-09 | Storage administration | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | E |
| SYS-10 | External rescue | [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | C |
| PKG-01 | Missing-tool discovery | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-02 | Standard package ecosystems | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-03 | Capability catalogue | [05 Software and capability installation](05-software-and-capability-installation.md) | E |
| PKG-04 | Install plans | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-05 | Installation grants | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-06 | Version and provenance record | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-07 | Health and smoke checks | [05 Software and capability installation](05-software-and-capability-installation.md) | C |
| PKG-08 | Update and rollback | [05 Software and capability installation](05-software-and-capability-installation.md) | E |
| PKG-09 | Agent-authored tools | [05 Software and capability installation](05-software-and-capability-installation.md) | E |
| PKG-10 | Rebuildable machine | [05 Software and capability installation](05-software-and-capability-installation.md) | E |
| WEB-01 | Headless server browser | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-02 | Observe-act-verify tools | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-03 | Visual perception | [06 Headless browser and live takeover](06-headless-browser.md) | E |
| WEB-04 | Durable browser identities | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-05 | Live browser viewer | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-06 | Human takeover | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-07 | Multi-tab research | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-08 | Reliable page data | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-09 | Debug and test websites | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| WEB-10 | Browser session recovery | [06 Headless browser and live takeover](06-headless-browser.md) | C |
| ID-01 | Account inventory | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-02 | OAuth and delegated access | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-03 | Fresh server login | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-04 | Local Chrome companion | [07 Agent and owner identities](07-identities-and-credentials.md) | E |
| ID-05 | Selected credential migration | [07 Agent and owner identities](07-identities-and-credentials.md) | E |
| ID-06 | Selected session transfer | [07 Agent and owner identities](07-identities-and-credentials.md) | E |
| ID-07 | Secret-use requests | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-08 | MFA, OTP, and passkeys | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-09 | Account lifecycle | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| ID-10 | Agent-first identity separation | [07 Agent and owner identities](07-identities-and-credentials.md) | C |
| CAP-01 | Challenge recognition | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | C |
| CAP-02 | Resume after a challenge | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | C |
| CAP-03 | Self-hosted solver plugins | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | E |
| CAP-04 | Local solving experiments | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | A |
| CAP-05 | Challenge budget | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | E |
| CAP-06 | Human challenge UI | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | C |
| CAP-07 | Challenge memory | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | E |
| CAP-08 | Respect explicit denial | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | C |
| CAP-09 | Challenge observability | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | C |
| CAP-10 | Provider conformance | [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | E |
| DEV-01 | Repository understanding | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-02 | Reproduce and debug | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-03 | Precise edits | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-04 | Semantic code tools | [09 Coding and software engineering](09-coding-and-review.md) | E |
| DEV-05 | Build and test | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-06 | Feature implementation | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-07 | Browser-driven development | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-08 | Code review | [09 Coding and software engineering](09-coding-and-review.md) | E |
| DEV-09 | Change checkpoints | [09 Coding and software engineering](09-coding-and-review.md) | C |
| DEV-10 | Platform-specific build handoff | [09 Coding and software engineering](09-coding-and-review.md) | A |
| GIT-01 | GitHub CLI | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-02 | Repository lifecycle | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-03 | Branches and worktrees | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-04 | Commits and PRs | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-05 | CI investigation | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-06 | Review-response work | [10 Git hosting and delivery](10-github-and-delivery.md) | E |
| GIT-07 | Merge and release | [10 Git hosting and delivery](10-github-and-delivery.md) | E |
| GIT-08 | Conflicts and history | [10 Git hosting and delivery](10-github-and-delivery.md) | C |
| GIT-09 | Git hosting adapters | [10 Git hosting and delivery](10-github-and-delivery.md) | E |
| GIT-10 | Repository event tasks | [10 Git hosting and delivery](10-github-and-delivery.md) | E |
| OPS-01 | Diagnose running services | [11 Server operations and deployments](11-server-operations-and-deployment.md) | C |
| OPS-02 | Container operations | [11 Server operations and deployments](11-server-operations-and-deployment.md) | C |
| OPS-03 | Deployment workflow | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-04 | Infrastructure as code | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-05 | Cloud and hosting adapters | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-06 | Domain/DNS/TLS work | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-07 | Databases and migrations | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-08 | Incident procedures | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-09 | Cost-aware resource lifecycle | [11 Server operations and deployments](11-server-operations-and-deployment.md) | E |
| OPS-10 | Agent self-maintenance | [11 Server operations and deployments](11-server-operations-and-deployment.md) | C |
| RES-01 | Self-hosted search | [12 Research and source collection](12-research-and-sources.md) | C |
| RES-02 | Source-grounded answers | [12 Research and source collection](12-research-and-sources.md) | C |
| RES-03 | Deep research tasks | [12 Research and source collection](12-research-and-sources.md) | E |
| RES-04 | Structured extraction | [12 Research and source collection](12-research-and-sources.md) | C |
| RES-05 | Responsible crawling | [12 Research and source collection](12-research-and-sources.md) | E |
| RES-06 | Change monitoring | [12 Research and source collection](12-research-and-sources.md) | E |
| RES-07 | Mixed-source research | [12 Research and source collection](12-research-and-sources.md) | C |
| RES-08 | Comparison dossiers | [12 Research and source collection](12-research-and-sources.md) | E |
| RES-09 | Reproducible datasets | [12 Research and source collection](12-research-and-sources.md) | E |
| RES-10 | Research-to-action handoff | [12 Research and source collection](12-research-and-sources.md) | E |
| DOC-01 | Read heterogeneous documents | [13 Documents and deliverables](13-documents-and-deliverables.md) | C |
| DOC-02 | Write reports and documents | [13 Documents and deliverables](13-documents-and-deliverables.md) | C |
| DOC-03 | Spreadsheet work | [13 Documents and deliverables](13-documents-and-deliverables.md) | C |
| DOC-04 | Slide decks | [13 Documents and deliverables](13-documents-and-deliverables.md) | E |
| DOC-05 | PDF workflows | [13 Documents and deliverables](13-documents-and-deliverables.md) | E |
| DOC-06 | Render and inspect | [13 Documents and deliverables](13-documents-and-deliverables.md) | C |
| DOC-07 | Revision and review | [13 Documents and deliverables](13-documents-and-deliverables.md) | E |
| DOC-08 | Batch transformations | [13 Documents and deliverables](13-documents-and-deliverables.md) | E |
| DOC-09 | Template library | [13 Documents and deliverables](13-documents-and-deliverables.md) | E |
| DOC-10 | Delivery workflow | [13 Documents and deliverables](13-documents-and-deliverables.md) | C |
| DATA-01 | Local analysis | [14 Data analysis and databases](14-data-and-databases.md) | C |
| DATA-02 | Data quality reports | [14 Data analysis and databases](14-data-and-databases.md) | C |
| DATA-03 | Charts and explanations | [14 Data analysis and databases](14-data-and-databases.md) | C |
| DATA-04 | Query connected databases | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-05 | Approved data mutations | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-06 | Data pipelines | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-07 | API datasets | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-08 | Notebook and script outputs | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-09 | Large-data execution | [14 Data analysis and databases](14-data-and-databases.md) | E |
| DATA-10 | Business/finance preparation | [14 Data analysis and databases](14-data-and-databases.md) | E |
| COM-01 | Email reading and triage | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-02 | Draft and send mail | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-03 | Calendar assistance | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-04 | Chat integrations | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-05 | Meeting preparation | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-06 | Contact and relationship context | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-07 | Task intake from messages | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| COM-08 | Notification routing | [15 Communication and calendar](15-communication-and-calendar.md) | C |
| COM-09 | Shared systems administration | [15 Communication and calendar](15-communication-and-calendar.md) | A |
| COM-10 | Delivery reconciliation | [15 Communication and calendar](15-communication-and-calendar.md) | E |
| LIFE-01 | Account administration | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-02 | Travel and appointments | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-03 | Forms and applications | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-04 | Shopping and procurement | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-05 | Subscription management | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-06 | Returns and support | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-07 | Personal file organization | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-08 | Deadline preparation | [16 Personal workflows and errands](16-personal-workflows.md) | E |
| LIFE-09 | Multi-step errands | [16 Personal workflows and errands](16-personal-workflows.md) | A |
| LIFE-10 | Home and lab integrations | [16 Personal workflows and errands](16-personal-workflows.md) | A |
| PAY-01 | Purchase preparation | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-02 | Whole payment workflow approval | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-03 | Authorized workflow execution and handoff | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-04 | Brokered payment method | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-05 | Bounded virtual instrument | [17 Payment workflows and purchases](17-payments-and-purchases.md) | A |
| PAY-06 | Standing purchase mandate | [17 Payment workflows and purchases](17-payments-and-purchases.md) | A |
| PAY-07 | Step-up authentication | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-08 | No duplicate purchases | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-09 | Receipts and aftercare | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| PAY-10 | Spending control centre | [17 Payment workflows and purchases](17-payments-and-purchases.md) | E |
| AUTO-01 | One-time and recurring work | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | C |
| AUTO-02 | Meaningful monitors | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | E |
| AUTO-03 | Durable scheduling semantics | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | C |
| AUTO-04 | Webhook and event triggers | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | E |
| AUTO-05 | Heartbeat goals | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | E |
| AUTO-06 | Bounded automatic remediation | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | E |
| AUTO-07 | Approval while unattended | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | C |
| AUTO-08 | Resource and spend budgets | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | E |
| AUTO-09 | Automation management | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | C |
| AUTO-10 | Schedules are explicit authority | [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | C |
| MEM-01 | Explicit durable memory | [19 Memory and retrieval](19-memory-and-retrieval.md) | C |
| MEM-02 | Episodic task history | [19 Memory and retrieval](19-memory-and-retrieval.md) | C |
| MEM-03 | Local semantic retrieval | [19 Memory and retrieval](19-memory-and-retrieval.md) | E |
| MEM-04 | Task working state | [19 Memory and retrieval](19-memory-and-retrieval.md) | C |
| MEM-05 | Provenance and freshness | [19 Memory and retrieval](19-memory-and-retrieval.md) | C |
| MEM-06 | Inspect, correct, and forget | [19 Memory and retrieval](19-memory-and-retrieval.md) | E |
| MEM-07 | Knowledge collections | [19 Memory and retrieval](19-memory-and-retrieval.md) | E |
| MEM-08 | Procedure learning | [19 Memory and retrieval](19-memory-and-retrieval.md) | E |
| MEM-09 | Memory never grants permission | [19 Memory and retrieval](19-memory-and-retrieval.md) | C |
| MEM-10 | Controlled consolidation | [19 Memory and retrieval](19-memory-and-retrieval.md) | A |
| TEAM-01 | Worker roles | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-02 | Bounded delegation | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-03 | Task dependency graph | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-04 | Workspace coordination | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-05 | Cloud-capacity-aware queue | [20 Specialist workers and coordination](20-specialist-workers.md) | C |
| TEAM-06 | Independent verification | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-07 | Budget inheritance | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-08 | Worker recovery | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-09 | Owner-visible delegation | [20 Specialist workers and coordination](20-specialist-workers.md) | E |
| TEAM-10 | Same-server worker expansion | [20 Specialist workers and coordination](20-specialist-workers.md) | A |
| EXT-01 | Pi extension support | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | C |
| EXT-02 | Self-hosted MCP connectors | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | E |
| EXT-03 | Simple CLI adapters | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | C |
| EXT-04 | Capability manifest | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | E |
| EXT-05 | Dynamic tool discovery | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | C |
| EXT-06 | Capability packs | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | E |
| EXT-07 | In-process trust distinction | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | C |
| EXT-08 | Permissions on upgrade | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | E |
| EXT-09 | Local interoperability adapters | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | A |
| EXT-10 | Owner's private registry | [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | E |
| MODEL-01 | Ollama Cloud primary path | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-02 | Cloud capability probes | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-03 | Operator, reviewer and vision roles | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-04 | Explicit model inventory | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-05 | Cloud health and usage | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-06 | Context management | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-07 | Task-based evaluations | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | C |
| MODEL-08 | Approved Cloud fallback | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | E |
| MODEL-09 | Hosted model changes | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | E |
| MODEL-10 | Efficient execution modes | [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | E |
| MEDIA-01 | Voice task input | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-02 | Spoken updates | [23 Speech, images and media](23-speech-images-and-media.md) | A |
| MEDIA-03 | Screenshot understanding | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-04 | OCR and scanned records | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-05 | Image transformations | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-06 | Open image-generation tools | [23 Speech, images and media](23-speech-images-and-media.md) | A |
| MEDIA-07 | Audio/video processing | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-08 | Meeting recordings | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MEDIA-09 | Multimodal deliverables | [23 Speech, images and media](23-speech-images-and-media.md) | A |
| MEDIA-10 | Media resource budgets | [23 Speech, images and media](23-speech-images-and-media.md) | E |
| MAC-01 | Native app shell | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-02 | Projects and tasks sidebar | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-03 | Conversation and plan | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-04 | Contextual evidence surfaces | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-05 | Code review surface | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-06 | Machine and capabilities | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-07 | Approvals and accounts | [24 Swift macOS client](24-swift-macos-client.md) | C |
| MAC-08 | Local companion | [24 Swift macOS client](24-swift-macos-client.md) | E |
| MAC-09 | Automation and memory tools | [24 Swift macOS client](24-swift-macos-client.md) | E |
| MAC-10 | Native quality | [24 Swift macOS client](24-swift-macos-client.md) | C |
| PHONE-01 | Native sessions and inbox | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | C |
| PHONE-02 | Equal client continuity | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | C |
| PHONE-03 | Equal native approvals | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | C |
| PHONE-04 | Server inbox and Apple push | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | C |
| PHONE-05 | Browser takeover | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | E |
| PHONE-06 | File and voice intake | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | E |
| PHONE-07 | Pairing and revocation | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | C |
| PHONE-08 | Readable offline history | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | E |
| PHONE-09 | Lock-screen notifications and status | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | E |
| PHONE-10 | Remote emergency controls | [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | E |
| TRUST-01 | Three modes and scoped authority | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-02 | External effect mediation | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-03 | Instruction provenance | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-04 | Sensitive-data minimization | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-05 | Protected audit trail | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-06 | Reauthentication and exact binding | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-07 | Data boundaries | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-08 | Revocation and emergency stop | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-09 | Plugin and dependency trust | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | C |
| TRUST-10 | Owner visibility and export | [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | E |
| REL-01 | Health and diagnosis | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-02 | Transactional outbox | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-03 | End-to-end identity | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-04 | Backup and restore | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-05 | Safe upgrades | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-06 | Resource economics | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | E |
| REL-07 | Deterministic fixtures | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-08 | Real model/site evaluations | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-09 | Graceful degradation | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | C |
| REL-10 | Long-term portability | [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | E |
