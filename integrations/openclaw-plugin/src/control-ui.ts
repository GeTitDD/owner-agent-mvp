import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const cell = (text: string): HTMLTableCellElement => {
  const td = el("td", undefined, text);
  td.title = text;
  return td;
};

const table = (headers: string[], rows: Array<Array<string | HTMLElement>>): HTMLTableElement => {
  const node = el("table", "owner-table");
  const head = el("thead");
  const headRow = el("tr");
  for (const header of headers) headRow.append(el("th", undefined, header));
  head.append(headRow);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const value of row) tr.append(typeof value === "string" ? cell(value) : value);
    body.append(tr);
  }
  node.append(head, body);
  return node;
};

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({
      id: "owner-agent",
      label: "Owner",
      page: { id: "owner-agent" },
      icon: "fileText"
    });

    host.ui.registerPage({
      id: "owner-agent",
      label: "Owner Agent",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);

        const root = el("div", "owner-page");
        const header = el("div", "owner-header");
        const heading = el("h1", undefined, "Owner Agent");
        const refresh = el("button", "owner-button", "Refresh");
        header.append(heading, refresh);
        const note = el(
          "p",
          "owner-muted",
          "Jobs, patches, sandbox runs and repair cycles stay under Owner authority. Approvals here are hash-bound and recorded by Owner."
        );
        const error = el("p", "owner-error");
        const status = el("div", "owner-cards");
        const sections = el("div", "owner-sections");
        root.append(header, note, error, status, sections);
        container.append(root);

        let disposed = false;
        let loading = false;

        const report = (cause: unknown): void => {
          if (!disposed) error.textContent = String(cause);
        };

        const actionButton = (label: string, run: () => Promise<unknown>): HTMLButtonElement => {
          const button = el("button", "owner-button owner-button-danger", label);
          button.onclick = async () => {
            if (!window.confirm(`${label}? Owner will record this decision.`)) return;
            button.disabled = true;
            error.textContent = "";
            try {
              await run();
              await load();
            } catch (cause) {
              report(cause);
            } finally {
              if (!disposed) button.disabled = false;
            }
          };
          return button;
        };

        const renderStatus = (summary: {
          projectCount: number;
          totalJobs: number;
          pendingJobApprovals: number;
          pendingPatchApprovals: number;
          pendingRepairApprovals: number;
          pendingSandboxApprovals: number;
        }): void => {
          status.replaceChildren(
            ...([
              ["Projects", summary.projectCount],
              ["Jobs", summary.totalJobs],
              ["Pending job approvals", summary.pendingJobApprovals],
              ["Pending patch approvals", summary.pendingPatchApprovals],
              ["Pending repair approvals", summary.pendingRepairApprovals],
              ["Pending sandbox approvals", summary.pendingSandboxApprovals]
            ] as Array<[string, number]>).map(([label, value]) => {
              const card = el("div", "owner-card");
              card.append(
                el("span", "owner-card-value", String(value)),
                el("span", "owner-card-label", label)
              );
              return card;
            })
          );
        };

        const section = (title: string, body: HTMLElement): HTMLElement => {
          const wrapper = el("section", "owner-section");
          wrapper.append(el("h2", undefined, title), body);
          return wrapper;
        };

        const empty = (text: string): HTMLElement => el("p", "owner-muted", text);

        const load = async (): Promise<void> => {
          if (loading || disposed) return;
          loading = true;
          refresh.disabled = true;
          error.textContent = "";
          try {
            const [summary, jobs, patches, repairs, sandboxes] = await Promise.all([
              feature.invoke("status", {}),
              feature.invoke("jobs.list", { limit: 20 }),
              feature.invoke("patch.list", { limit: 20 }),
              feature.invoke("repair.list", { limit: 20 }),
              feature.invoke("sandbox.list", { limit: 20 })
            ]);
            if (disposed) return;
            renderStatus(summary);

            sections.replaceChildren(
              section(
                "Jobs",
                jobs.items.length === 0
                  ? empty("No jobs yet.")
                  : table(
                    ["Title", "Type", "Status", ""],
                    jobs.items.map((job) => [
                      job.title,
                      job.jobType,
                      job.status,
                      job.status === "pending_approval"
                        ? actionButton("Approve job", () =>
                          feature.invoke("job.approve", { id: job.id }))
                        : ""
                    ])
                  )
              ),
              section(
                "Patch proposals",
                patches.items.length === 0
                  ? empty("No patch proposals.")
                  : table(
                    ["Proposal", "Status", "Paths", ""],
                    patches.items.map((patch) => [
                      patch.id.slice(0, 8),
                      patch.status,
                      patch.paths.join(", ") || "-",
                      patch.status === "proposed"
                        ? actionButton("Approve & apply", () =>
                          feature.invoke("patch.approve", {
                            proposalId: patch.id,
                            hash: patch.proposalHash
                          }))
                        : patch.status === "applied"
                          ? actionButton("Test in sandbox", () =>
                            feature.invoke("sandbox.submit", { proposalId: patch.id }))
                          : ""
                    ])
                  )
              ),
              section(
                "Sandbox runs",
                sandboxes.items.length === 0
                  ? empty("No sandbox runs.")
                  : table(
                    ["Run", "Status", "Execution", "Tests", ""],
                    sandboxes.items.map((run) => [
                      run.id.slice(0, 8),
                      run.status,
                      run.executionStatus || "-",
                      run.testStatus || "-",
                      run.status === "pending_approval"
                        ? actionButton("Approve sandbox", () =>
                          feature.invoke("sandbox.approve", {
                            runId: run.id,
                            hash: run.approvalHash
                          }))
                        : ""
                    ])
                  )
              ),
              section(
                "Repair cycles",
                repairs.items.length === 0
                  ? empty("No repair cycles.")
                  : table(
                    ["Cycle", "Status", ""],
                    repairs.items.map((cycle) => [
                      cycle.id.slice(0, 8),
                      cycle.status,
                      cycle.status === "pending_approval"
                        ? actionButton("Approve repair", () =>
                          feature.invoke("repair.approve", {
                            cycleId: cycle.id,
                            hash: cycle.approvalHash
                          }))
                        : ""
                    ])
                  )
              )
            );
          } catch (cause) {
            report(cause);
          } finally {
            loading = false;
            if (!disposed) refresh.disabled = false;
          }
        };

        refresh.onclick = () => { void load(); };
        void load();

        return { dispose: () => { disposed = true; root.remove(); } };
      }
    });
  }
});
