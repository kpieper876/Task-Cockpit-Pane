const {
  Plugin,
  ItemView,
  Notice,
  TFile,
  Modal,
  PluginSettingTab,
  Setting
} = require("obsidian");

const VIEW_TYPE_TASK_COCKPIT = "task-cockpit-view";

const DEFAULT_SETTINGS = {
  cutoffDays: 90,
  peopleFolders: "People",
  projectsRoot: "Projects",
  productsRoot: "Products",
  ignoreFolders: "Templates",
  meName: "Your Name",
  includeUnassigned: true,
  showCompleted: false
};

function lower(s) { return String(s || "").toLowerCase(); }
function topSeg(path) { return String(path || "").split("/")[0]; }
function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appendSmartTaskText(parent, row, plugin) {
  parent.empty();
  const source = String(row.body || row.originalText || "");
  const rx = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/\S+)|(\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|([^\]]+))?\]\])/g;
  let last = 0;
  let m;
  function addText(t) {
    if (!t) return;
    parent.appendText(t);
  }
  while ((m = rx.exec(source))) {
    addText(source.slice(last, m.index));
    const full = m[0];
    if (m[1]) {
      const mm = full.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (mm) {
        const a = parent.createEl("a", { text: mm[1] || "external link", href: mm[2] });
        a.addClass("task-cockpit-link");
        a.setAttr("target", "_blank");
        a.setAttr("rel", "noopener");
      } else addText(full);
    } else if (m[2]) {
      let url = m[2];
      let trailing = "";
      while (/[\]\),.;:]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      const a = parent.createEl("a", { text: "external link", href: url });
      a.addClass("task-cockpit-link");
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener");
      if (trailing) addText(trailing);
    } else if (m[3]) {
      const target = m[4];
      const alias = m[5] || target;
      const a = parent.createEl("a", { text: alias });
      a.addClass("task-cockpit-link");
      a.onclick = async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const file = plugin.resolveName(target) || plugin.resolveName(alias);
        if (file) await plugin.app.workspace.getLeaf(false).openFile(file);
        else new Notice("Linked note not found: " + target);
      };
    } else addText(full);
    last = rx.lastIndex;
  }
  addText(source.slice(last));
}

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function addDaysIso(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function toFolderList(csv) {
  return String(csv || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
function fileInFolder(file, folder) {
  const parent = file.parent && file.parent.path ? file.parent.path : "";
  return parent === folder || parent.startsWith(folder + "/");
}
function parseAliases(frontmatter) {
  if (!frontmatter) return [];
  const raw = frontmatter.aliases || frontmatter.alias;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}
function parseTaskLine(line) {
  const m = String(line || "").match(/^(\s*[-*+]\s*\[)([ xX])(\]\s*)(.*)$/);
  if (!m) return null;
  return { prefixA: m[1], mark: m[2], suffixB: m[3], text: m[4] };
}
function priorityFromText(text) {
  const s = String(text || "");
  if (/⏫|#priority\/high|\[priority::\s*high\]/i.test(s)) return "High";
  if (/⏺|#priority\/medium|\[priority::\s*medium\]/i.test(s)) return "Medium";
  if (/⏬|#priority\/low|\[priority::\s*low\]/i.test(s)) return "Low";
  return "";
}
function prioritySymbol(priority) {
  if (priority === "High") return "⏫";
  if (priority === "Medium") return "⏺";
  if (priority === "Low") return "⏬";
  return "";
}
function dueFromText(text) {
  const m = String(text || "").match(/\[due::\s*([^\]]+)\]/i);
  return m ? String(m[1]).trim().replace(/^\[\[/, "").replace(/\]\]$/, "") : "";
}
function wikiTargets(text) {
  const out = [];
  const rx = /\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|([^\]]*))?\]\]/g;
  let m;
  while ((m = rx.exec(String(text || "")))) {
    out.push(m[1].trim());
    if (m[2]) out.push(m[2].trim());
  }
  return out;
}
function normalizeForMatch(s) {
  return lower(String(s || "").replace(/\.md$/i, "").trim());
}
function stripKnownMetadata(text, knownLinkNames) {
  let out = String(text || "");
  out = out.replace(/^\s*(⏫|⏺|⏬)\s*/, "");
  out = out.replace(/\s*#priority\/(high|medium|low)\b/gi, "");
  out = out.replace(/\s*\[priority::\s*(high|medium|low)\]/gi, "");
  out = out.replace(/\s*\[due::\s*[^\]]+\]/gi, "");
  out = out.replace(/\s*\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|([^\]]*))?\]\]/g, (full, target, alias) => {
    const t = normalizeForMatch(target);
    const a = normalizeForMatch(alias || "");
    if (knownLinkNames.has(t) || (a && knownLinkNames.has(a))) return "";
    return full;
  });
  return out.replace(/\s{2,}/g, " ").trim();
}
function rebuildTaskText(body, meta) {
  const parts = [];
  const sym = prioritySymbol(meta.priority);
  if (sym) parts.push(sym);
  if (body) parts.push(body.trim());
  for (const person of meta.people || []) if (person) parts.push(`[[${person}]]`);
  if (meta.project) parts.push(`[[${meta.project}]]`);
  if (meta.product) parts.push(`[[${meta.product}]]`);
  if (meta.due) parts.push(`[due:: ${meta.due}]`);
  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}
function comparePriority(a, b) {
  const score = { High: 3, Medium: 2, Low: 1, "": 0 };
  return (score[b.priority] || 0) - (score[a.priority] || 0);
}

class TaskEditModal extends Modal {
  constructor(app, plugin, row, onSave) {
    super(app);
    this.plugin = plugin;
    this.row = row;
    this.onSave = onSave;
    this.form = JSON.parse(JSON.stringify(row.meta));
    this.body = row.body;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-cockpit-modal");
    contentEl.createEl("h2", { text: "Edit task" });

    new Setting(contentEl)
      .setName("Task text")
      .addTextArea(t => {
        t.setValue(this.body);
        t.inputEl.rows = 5;
        t.inputEl.addClass("task-cockpit-full-width");
        t.onChange(v => this.body = v);
      });

    new Setting(contentEl)
      .setName("Priority")
      .addDropdown(d => {
        ["", "High", "Medium", "Low"].forEach(v => d.addOption(v, v || "None"));
        d.setValue(this.form.priority || "");
        d.onChange(v => this.form.priority = v);
      });

    new Setting(contentEl)
      .setName("Assignee")
      .addDropdown(d => {
        d.addOption("", "Unassigned");
        for (const name of this.plugin.peopleNames) d.addOption(name, name);
        d.setValue((this.form.people && this.form.people[0]) || "");
        d.onChange(v => this.form.people = v ? [v] : []);
      });

    new Setting(contentEl)
      .setName("Project")
      .addDropdown(d => {
        d.addOption("", "None");
        for (const name of this.plugin.projectNames) d.addOption(name, name);
        d.setValue(this.form.project || "");
        d.onChange(v => this.form.project = v);
      });

    new Setting(contentEl)
      .setName("Product")
      .addDropdown(d => {
        d.addOption("", "None");
        for (const name of this.plugin.productNames) d.addOption(name, name);
        d.setValue(this.form.product || "");
        d.onChange(v => this.form.product = v);
      });

    new Setting(contentEl)
      .setName("Due date")
      .addText(t => {
        t.setPlaceholder("YYYY-MM-DD");
        t.setValue(this.form.due || "");
        t.onChange(v => this.form.due = v.trim());
      })
      .addButton(b => b.setButtonText("Today").onClick(() => { this.form.due = isoToday(); this.close(); this.saveAndClose(); }))
      .addButton(b => b.setButtonText("Tomorrow").onClick(() => { this.form.due = addDaysIso(1); this.close(); this.saveAndClose(); }))
      .addButton(b => b.setButtonText("Clear").onClick(() => { this.form.due = ""; this.close(); this.saveAndClose(); }));

    new Setting(contentEl)
      .addButton(b => b.setButtonText("Save").setCta().onClick(() => this.saveAndClose()))
      .addButton(b => b.setButtonText("Open source").onClick(async () => {
        await this.plugin.openSource(this.row);
        this.close();
      }))
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  async saveAndClose() {
    const newText = rebuildTaskText(this.body, this.form);
    await this.onSave(newText);
    this.close();
  }
}

class TaskCockpitView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.rows = [];
    this.filters = {
      person: "All",
      project: "All",
      due: "Overdue + 5d",
      priority: "All",
      query: "",
      sort: "Priority",
      groupBy: "Project + Product",
      onlyGrouped: false,
      onlyUnclassified: false,
      cutoffDays: Number(this.plugin.settings.cutoffDays) || 90
    };
    this.collapsedGroups = new Set();
    this.defaultsApplied = false;
  }

  getViewType() { return VIEW_TYPE_TASK_COCKPIT; }
  getDisplayText() { return "Task Cockpit"; }
  getIcon() { return "list-checks"; }

  async onOpen() { await this.render(); }

  async render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("task-cockpit-root");

    const header = root.createDiv({ cls: "task-cockpit-header" });
    header.createEl("h2", { text: "Task Cockpit" });
    const refresh = header.createEl("button", { text: "Refresh" });
    refresh.onclick = () => this.render();

    await this.plugin.refreshIndexes();
    this.rows = await this.plugin.collectTasks(this.filters.cutoffDays);

    // First-render smart default: if "Overdue + 5d" matches nothing, drop the
    // due filter so the user isn't staring at an empty view.
    if (!this.defaultsApplied) {
      this.defaultsApplied = true;
      if (this.filters.due === "Overdue + 5d") {
        const probe = this.filteredRows();
        if (probe.length === 0) this.filters.due = "All";
      }
    }

    this.renderToolbar(root);
    const filtered = this.filteredRows();
    root.createDiv({ cls: "task-cockpit-count", text: `${filtered.length} task${filtered.length === 1 ? "" : "s"}` });
    this.renderRows(root, filtered);
  }

  renderToolbar(root) {
    const bar = root.createDiv({ cls: "task-cockpit-toolbar" });

    this.addSelect(bar, "Group by", ["Project", "Product", "Project + Product", "Person", "Priority", "Due Date"], this.filters.groupBy, v => { this.filters.groupBy = v; this.renderRowsOnly(root); });
    this.addSelect(bar, "Sort", ["Priority", "Due Date", "Project", "Product", "Person", "Text"], this.filters.sort, v => { this.filters.sort = v; this.renderRowsOnly(root); });

    // Visible top-level toggles. The two are mutually exclusive — turning one
    // on clears the other to avoid contradictory filters (a task can't be both
    // "fully grouped" and "completely unclassified").
    const toggleWrap = bar.createDiv({ cls: "task-cockpit-toggles" });
    let onlyGroupedCb, onlyUnclassifiedCb;
    onlyGroupedCb = this.addCheckbox(toggleWrap, "Only grouped items", !!this.filters.onlyGrouped,
      "Hide tasks with no project/product/etc. — show only items that fall into a real group.",
      v => {
        this.filters.onlyGrouped = v;
        if (v && this.filters.onlyUnclassified) {
          this.filters.onlyUnclassified = false;
          if (onlyUnclassifiedCb) onlyUnclassifiedCb.checked = false;
        }
        this.renderRowsOnly(root);
      });
    onlyUnclassifiedCb = this.addCheckbox(toggleWrap, "Only unclassified", !!this.filters.onlyUnclassified,
      "Show only tasks with no project, no product, no person, AND no priority.",
      v => {
        this.filters.onlyUnclassified = v;
        if (v && this.filters.onlyGrouped) {
          this.filters.onlyGrouped = false;
          if (onlyGroupedCb) onlyGroupedCb.checked = false;
        }
        this.renderRowsOnly(root);
      });

    const groupActions = bar.createDiv({ cls: "task-cockpit-group-actions" });
    groupActions.createEl("button", { text: "Expand all" }).onclick = () => {
      this.collapsedGroups.clear();
      this.renderRowsOnly(root);
    };
    groupActions.createEl("button", { text: "Collapse all" }).onclick = () => {
      const rows = this.filteredRows();
      const keys = new Set();
      if (this.filters.groupBy === "Project + Product") {
        for (const row of rows) {
          if (row.meta.project) keys.add(this.groupStateKey("Project: " + row.meta.project));
          if (row.meta.product) keys.add(this.groupStateKey("Product: " + row.meta.product));
          if (!row.meta.project && !row.meta.product) keys.add(this.groupStateKey("No project or product"));
        }
      } else {
        for (const row of rows) keys.add(this.groupStateKey(this.groupValue(row)));
      }
      this.collapsedGroups = keys;
      this.renderRowsOnly(root);
    };

    const menu = bar.createEl("details", { cls: "task-cockpit-filter-menu" });
    menu.createEl("summary", { text: "Filters" });
    const filterGrid = menu.createDiv({ cls: "task-cockpit-filter-grid" });

    this.addSelect(filterGrid, "Person", ["All", "Me", "Unassigned", ...this.plugin.peopleNames], this.filters.person, v => { this.filters.person = v; this.renderRowsOnly(root); });
    this.addSelect(filterGrid, "Due", ["All", "Overdue + 5d", "No due", "Overdue", "Today", "Future"], this.filters.due, v => { this.filters.due = v; this.renderRowsOnly(root); });
    this.addSelect(filterGrid, "Priority", ["All", "High", "Medium", "Low", "No priority"], this.filters.priority, v => { this.filters.priority = v; this.renderRowsOnly(root); });

    const historyWrap = filterGrid.createDiv({ cls: "task-cockpit-control" });
    historyWrap.createSpan({ text: "History window" });
    const history = historyWrap.createEl("input", { type: "number", value: String(this.filters.cutoffDays || 90) });
    history.min = "1";
    history.step = "1";
    history.title = "Include tasks from files changed within this many days. Overdue and today are always included.";
    history.onchange = () => {
      const next = Math.max(1, Number(history.value) || 90);
      this.filters.cutoffDays = next;
      history.value = String(next);
      this.render();
    };

    const searchWrap = filterGrid.createDiv({ cls: "task-cockpit-control task-cockpit-search" });
    searchWrap.createSpan({ text: "Search" });
    const search = searchWrap.createEl("input", { type: "search", value: this.filters.query });
    search.oninput = () => { this.filters.query = search.value; this.renderRowsOnly(root); };
  }

  addCheckbox(parent, label, value, title, onChange) {
    const wrap = parent.createEl("label", { cls: "task-cockpit-toggle" });
    const cb = wrap.createEl("input", { type: "checkbox" });
    cb.checked = !!value;
    if (title) cb.title = title;
    wrap.createSpan({ text: label });
    cb.onchange = () => onChange(cb.checked);
    return cb;
  }

  addSelect(parent, label, options, value, onChange) {
    const wrap = parent.createDiv({ cls: "task-cockpit-control" });
    wrap.createSpan({ text: label });
    const select = wrap.createEl("select");
    for (const opt of options) select.createEl("option", { text: opt, value: opt });
    select.value = value;
    select.onchange = () => onChange(select.value);
  }

  renderRowsOnly(root) {
    const old = root.querySelector(".task-cockpit-list");
    if (old) old.remove();
    const rows = this.filteredRows();
    const count = root.querySelector(".task-cockpit-count");
    if (count) count.setText(`${rows.length} task${rows.length === 1 ? "" : "s"}`);
    this.renderRows(root, rows);
  }

  filteredRows() {
    let rows = [...this.rows];
    if (!this.plugin.settings.includeUnassigned) rows = rows.filter(r => r.meta.people.length > 0);
    if (this.filters.person === "Me") rows = rows.filter(r => r.meta.people.includes(this.plugin.settings.meName));
    else if (this.filters.person === "Unassigned") rows = rows.filter(r => r.meta.people.length === 0);
    else if (this.filters.person !== "All") rows = rows.filter(r => r.meta.people.includes(this.filters.person));
    const today = isoToday();
    if (this.filters.due === "No due") rows = rows.filter(r => !r.meta.due);
    if (this.filters.due === "Overdue") rows = rows.filter(r => r.meta.due && r.meta.due < today);
    if (this.filters.due === "Today") rows = rows.filter(r => r.meta.due === today);
    if (this.filters.due === "Future") rows = rows.filter(r => r.meta.due && r.meta.due > today);
    if (this.filters.due === "Overdue + 5d") {
      const horizon = isoOffset(5);
      rows = rows.filter(r => r.meta.due && r.meta.due <= horizon);
    }
    if (this.filters.priority && this.filters.priority !== "All") {
      const target = this.filters.priority;
      if (target === "No priority") rows = rows.filter(r => !r.meta.priority);
      else rows = rows.filter(r => r.meta.priority === target);
    }
    if (this.filters.query.trim()) {
      const q = lower(this.filters.query.trim());
      rows = rows.filter(r => lower(r.body + " " + r.file.basename + " " + r.meta.project + " " + r.meta.product + " " + r.meta.people.join(" ")).includes(q));
    }
    if (this.filters.onlyGrouped) {
      rows = rows.filter(r => this.isFullyGrouped(r));
    }
    if (this.filters.onlyUnclassified) {
      rows = rows.filter(r => !r.meta.project && !r.meta.product && !(r.meta.people && r.meta.people.length) && !r.meta.priority);
    }
    rows.sort((a, b) => {
      if (this.filters.sort === "Due Date") return (a.meta.due || "9999-99-99").localeCompare(b.meta.due || "9999-99-99") || comparePriority(a.meta, b.meta);
      if (this.filters.sort === "Project") return (a.meta.project || "~").localeCompare(b.meta.project || "~") || comparePriority(a.meta, b.meta);
      if (this.filters.sort === "Product") return (a.meta.product || "~").localeCompare(b.meta.product || "~") || comparePriority(a.meta, b.meta);
      if (this.filters.sort === "Person") return ((a.meta.people[0] || "~").localeCompare(b.meta.people[0] || "~")) || comparePriority(a.meta, b.meta);
      if (this.filters.sort === "Text") return a.body.localeCompare(b.body);
      return comparePriority(a.meta, b.meta) || (a.meta.due || "9999-99-99").localeCompare(b.meta.due || "9999-99-99");
    });
    return rows;
  }

  groupValue(row) {
    if (this.filters.groupBy === "Product") return row.meta.product || "No product";
    if (this.filters.groupBy === "Person") return (row.meta.people && row.meta.people.length) ? row.meta.people[0] : "Unassigned";
    if (this.filters.groupBy === "Priority") return row.meta.priority || "No priority";
    if (this.filters.groupBy === "Due Date") return row.meta.due || "No due date";
    if (this.filters.groupBy === "Project + Product") return row.meta.project || "No project";
    return row.meta.project || "No project";
  }

  // Secondary group key, only meaningful for nested grouping modes.
  // Returns "" when the active mode is flat (single-level).
  subGroupValue(row) {
    if (this.filters.groupBy === "Project + Product") return row.meta.product || "No product";
    return "";
  }

  // True when a group label is the placeholder (no real value present).
  isPlaceholderGroup(name) {
    return name === "No project"
      || name === "No product"
      || name === "No priority"
      || name === "No due date"
      || name === "Unassigned";
  }

  // True when a row is "fully grouped" — i.e., it has a real value for
  // every level of the active grouping mode. Used by the Only-grouped filter.
  isFullyGrouped(row) {
    if (this.filters.groupBy === "Product") return !!row.meta.product;
    if (this.filters.groupBy === "Person") return !!(row.meta.people && row.meta.people.length);
    if (this.filters.groupBy === "Priority") return !!row.meta.priority;
    if (this.filters.groupBy === "Due Date") return !!row.meta.due;
    if (this.filters.groupBy === "Project + Product") return !!row.meta.project || !!row.meta.product;
    return !!row.meta.project;
  }

  groupStateKey(name, subName) {
    const sub = subName ? `::${String(subName)}` : "";
    return `${this.filters.groupBy}::${String(name || "")}${sub}`;
  }

  groupSortValue(name) {
    if (this.filters.groupBy === "Priority") {
      const score = { High: 1, Medium: 2, Low: 3, "No priority": 4 };
      return score[name] || 99;
    }
    if (this.filters.groupBy === "Due Date") return name === "No due date" ? "9999-99-99" : name;
    return String(name || "").toLowerCase();
  }

  // Sort placeholder sub-group ("No product") last; otherwise alphabetical.
  subGroupSortValue(name) {
    if (name === "No product") return "\uFFFF";
    return String(name || "").toLowerCase();
  }

  renderRows(root, rows) {
    const list = root.createDiv({ cls: "task-cockpit-list" });
    const combined = this.filters.groupBy === "Project + Product";

    // Build groups. In combined mode a single task can appear in multiple
    // groups — once for its project, once for its product. We tag each
    // group entry with a kind ("project" | "product" | "") so we can show
    // a prefix and sort projects before products.
    const groups = new Map(); // displayKey -> { kind, name, rows: [] }
    const addTo = (displayKey, kind, name, row) => {
      let bucket = groups.get(displayKey);
      if (!bucket) {
        bucket = { kind, name, rows: [] };
        groups.set(displayKey, bucket);
      }
      bucket.rows.push(row);
    };

    if (combined) {
      for (const row of rows) {
        let placed = false;
        if (row.meta.project) {
          addTo("project::" + row.meta.project, "project", row.meta.project, row);
          placed = true;
        }
        if (row.meta.product) {
          addTo("product::" + row.meta.product, "product", row.meta.product, row);
          placed = true;
        }
        if (!placed) {
          addTo("none::No project or product", "", "No project or product", row);
        }
      }
    } else {
      for (const row of rows) {
        const name = this.groupValue(row);
        addTo(name, "", name, row);
      }
    }

    // Sort.
    const entries = Array.from(groups.entries()).sort((a, b) => {
      if (combined) {
        // projects first, then products, then "none" bucket last
        const rank = k => (k === "project" ? 0 : k === "product" ? 1 : 2);
        const r = rank(a[1].kind) - rank(b[1].kind);
        if (r !== 0) return r;
        return String(a[1].name).toLowerCase().localeCompare(String(b[1].name).toLowerCase());
      }
      const av = this.groupSortValue(a[1].name);
      const bv = this.groupSortValue(b[1].name);
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv));
    });

    for (const [, bucket] of entries) {
      const group = list.createDiv({ cls: "task-cockpit-group" });
      const prefix = combined && bucket.kind ? (bucket.kind === "project" ? "Project: " : "Product: ") : "";
      const headingLabel = prefix + bucket.name;
      const stateKey = this.groupStateKey(headingLabel);
      const isCollapsed = this.collapsedGroups.has(stateKey);

      const heading = group.createEl("h3", { cls: "task-cockpit-group-heading" });
      heading.createEl("button", {
        cls: "task-cockpit-group-toggle",
        text: isCollapsed ? "▸" : "▾",
        attr: { "aria-label": isCollapsed ? "Expand group" : "Collapse group" }
      });
      heading.createSpan({ text: `${headingLabel} (${bucket.rows.length})` });
      heading.onclick = () => {
        if (this.collapsedGroups.has(stateKey)) this.collapsedGroups.delete(stateKey);
        else this.collapsedGroups.add(stateKey);
        this.renderRowsOnly(root);
      };

      const groupBody = group.createDiv({ cls: "task-cockpit-group-body" });
      if (isCollapsed) {
        groupBody.addClass("is-collapsed");
        continue;
      }
      for (const row of bucket.rows) this.renderCard(groupBody, row);
    }
  }

  renderCard(parent, row) {
    const card = parent.createDiv({ cls: "task-cockpit-card" });
    const cb = card.createEl("input", { type: "checkbox" });
    cb.checked = row.completed;
    cb.onchange = async () => {
      await this.plugin.patchTask(row, parsed => `${parsed.prefixA}${cb.checked ? "x" : " "}${parsed.suffixB}${parsed.text}`);
      new Notice(cb.checked ? "Task completed" : "Task reopened");
      await this.render();
    };

    const main = card.createDiv({ cls: "task-cockpit-main" });
    const text = main.createDiv({ cls: "task-cockpit-text" });
    appendSmartTaskText(text, row, this.plugin);
    text.onclick = (evt) => {
      if (evt.target && evt.target.tagName === "A") return;
      this.plugin.openSource(row);
    };

    const meta = main.createDiv({ cls: "task-cockpit-meta" });
    meta.createSpan({ text: row.file.basename });
    if (row.meta.project) meta.createSpan({ text: " · " + row.meta.project });
    if (row.meta.product) meta.createSpan({ text: " · " + row.meta.product });

    const controls = main.createDiv({ cls: "task-cockpit-row-controls" });
    this.inlineSelect(controls, ["", "High", "Medium", "Low"], row.meta.priority || "", async v => this.updateMeta(row, { priority: v }));
    this.inlineSelect(controls, ["", ...this.plugin.peopleNames], row.meta.people[0] || "", async v => this.updateMeta(row, { people: v ? [v] : [] }));
    this.inlineSelect(controls, ["", ...this.plugin.projectNames], row.meta.project || "", async v => this.updateMeta(row, { project: v }));
    this.inlineSelect(controls, ["", ...this.plugin.productNames], row.meta.product || "", async v => this.updateMeta(row, { product: v }));
    const due = controls.createEl("input", { type: "date", value: row.meta.due || "" });
    due.onchange = async () => this.updateMeta(row, { due: due.value });
    controls.createEl("button", { text: "✏️" }).onclick = () => new TaskEditModal(this.app, this.plugin, row, async newText => {
      await this.plugin.patchTask(row, parsed => `${parsed.prefixA}${parsed.mark}${parsed.suffixB}${newText}`);
      await this.render();
    }).open();
    controls.createEl("button", { text: "↗" }).onclick = () => this.plugin.openSource(row);
  }

  inlineSelect(parent, options, value, onChange) {
    const s = parent.createEl("select");
    for (const opt of options) s.createEl("option", { text: opt || "—", value: opt });
    s.value = value;
    s.onchange = () => onChange(s.value);
  }

  async updateMeta(row, patch) {
    const meta = Object.assign({}, row.meta, patch);
    const newText = rebuildTaskText(row.body, meta);
    await this.plugin.patchTask(row, parsed => `${parsed.prefixA}${parsed.mark}${parsed.suffixB}${newText}`);
    await this.render();
  }
}

class TaskCockpitSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Task Cockpit settings" });
    new Setting(containerEl).setName("Cutoff days").setDesc("Only include tasks from files created/modified within this many days, unless overdue/today.")
      .addText(t => t.setValue(String(this.plugin.settings.cutoffDays)).onChange(async v => { this.plugin.settings.cutoffDays = Number(v) || 90; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("People folders").setDesc("Comma-separated folders containing person notes.")
      .addText(t => t.setValue(this.plugin.settings.peopleFolders).onChange(async v => { this.plugin.settings.peopleFolders = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Projects root")
      .addText(t => t.setValue(this.plugin.settings.projectsRoot).onChange(async v => { this.plugin.settings.projectsRoot = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Products root")
      .addText(t => t.setValue(this.plugin.settings.productsRoot).onChange(async v => { this.plugin.settings.productsRoot = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Ignore folders").setDesc("Comma-separated top-level or exact folders to skip.")
      .addText(t => t.setValue(this.plugin.settings.ignoreFolders).onChange(async v => { this.plugin.settings.ignoreFolders = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Me name")
      .addText(t => t.setValue(this.plugin.settings.meName).onChange(async v => { this.plugin.settings.meName = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Include unassigned")
      .addToggle(t => t.setValue(this.plugin.settings.includeUnassigned).onChange(async v => { this.plugin.settings.includeUnassigned = v; await this.plugin.saveSettings(); }));
  }
}

module.exports = class TaskCockpitPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.peopleNames = [];
    this.projectNames = [];
    this.productNames = [];
    this.aliasIndex = new Map();
    this.knownManagedLinkNames = new Set();

    this.registerView(VIEW_TYPE_TASK_COCKPIT, leaf => new TaskCockpitView(leaf, this));
    this.addRibbonIcon("list-checks", "Open Task Cockpit", () => this.activateView());
    this.addCommand({ id: "open-task-cockpit", name: "Open Task Cockpit", callback: () => this.activateView() });
    this.addSettingTab(new TaskCockpitSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_COCKPIT);
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_COCKPIT);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_TASK_COCKPIT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  shouldIgnore(file) {
    const parent = file.parent && file.parent.path ? file.parent.path : "";
    const ignored = toFolderList(this.settings.ignoreFolders).map(lower);
    const p = lower(parent);
    return ignored.some(ig => p === ig || topSeg(p) === ig || p.startsWith(ig + "/"));
  }

  async refreshIndexes() {
    this.aliasIndex.clear();
    this.knownManagedLinkNames.clear();
    const peopleFolders = toFolderList(this.settings.peopleFolders);
    const people = [];
    const projects = [];
    const products = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const names = [file.basename, ...parseAliases(cache && cache.frontmatter)];
      for (const n of names) if (n) this.aliasIndex.set(normalizeForMatch(n), file);
      if (peopleFolders.some(f => fileInFolder(file, f))) people.push(file.basename);
      if (fileInFolder(file, this.settings.projectsRoot)) projects.push(file.basename);
      if (fileInFolder(file, this.settings.productsRoot)) products.push(file.basename);
    }
    this.peopleNames = [...new Set(people)].sort();
    this.projectNames = [...new Set(projects)].sort();
    this.productNames = [...new Set(products)].sort();
    [...this.peopleNames, ...this.projectNames, ...this.productNames].forEach(n => this.knownManagedLinkNames.add(normalizeForMatch(n)));
  }

  resolveName(name) { return this.aliasIndex.get(normalizeForMatch(name)); }
  isPersonFile(file) { return file && toFolderList(this.settings.peopleFolders).some(f => fileInFolder(file, f)); }
  isProjectFile(file) { return file && fileInFolder(file, this.settings.projectsRoot); }
  isProductFile(file) { return file && fileInFolder(file, this.settings.productsRoot); }

  parseMeta(text, hostFile) {
    const meta = { priority: priorityFromText(text), due: dueFromText(text), people: [], project: "", product: "" };
    for (const target of wikiTargets(text)) {
      const f = this.resolveName(target);
      if (!f) continue;
      if (this.isPersonFile(f) && !meta.people.includes(f.basename)) meta.people.push(f.basename);
      else if (this.isProjectFile(f) && !meta.project) meta.project = f.basename;
      else if (this.isProductFile(f) && !meta.product) meta.product = f.basename;
    }
    if (!meta.project && this.isProjectFile(hostFile)) meta.project = hostFile.basename;
    if (!meta.product && this.isProductFile(hostFile)) meta.product = hostFile.basename;
    return meta;
  }

  async collectTasks(cutoffDaysOverride) {
    const rows = [];
    const now = Date.now();
    const cutoffDays = Number(cutoffDaysOverride || this.settings.cutoffDays) || 90;
    const cutoffMs = now - cutoffDays * 86400000;
    const today = isoToday();

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.shouldIgnore(file)) continue;
      const fileAgeMs = Math.max(file.stat.ctime || 0, file.stat.mtime || 0);
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseTaskLine(lines[i]);
        if (!parsed) continue;
        const completed = lower(parsed.mark) === "x";
        if (completed && !this.settings.showCompleted) continue;
        const meta = this.parseMeta(parsed.text, file);
        if (fileAgeMs < cutoffMs && !(meta.due && meta.due <= today)) continue;
        const body = stripKnownMetadata(parsed.text, this.knownManagedLinkNames);
        rows.push({ file, line: i, originalLine: lines[i], originalText: parsed.text, completed, meta, body });
      }
    }
    return rows;
  }

  async patchTask(row, builder) {
    const content = await this.app.vault.read(row.file);
    const lines = content.split(/\r?\n/);
    let idx = row.line;
    let parsed = parseTaskLine(lines[idx]);
    if (!parsed || parsed.text !== row.originalText) {
      idx = lines.findIndex(line => {
        const p = parseTaskLine(line);
        return p && p.text.trim() === row.originalText.trim();
      });
      if (idx < 0) {
        new Notice("Task line not found. Open the source note and refresh Task Cockpit.");
        return false;
      }
      parsed = parseTaskLine(lines[idx]);
    }
    lines[idx] = builder(parsed);
    await this.app.vault.modify(row.file, lines.join("\n"));
    return true;
  }

  async openSource(row) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(row.file);
    const view = leaf.view;
    if (view && view.editor) {
      view.editor.setCursor({ line: row.line, ch: 0 });
      view.editor.scrollIntoView({ from: { line: row.line, ch: 0 }, to: { line: row.line, ch: 0 } }, true);
    }
  }
};
