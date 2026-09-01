/// Command palette: one place to reach everything the viewer can do.
///
/// Lives here rather than in AppKit because nearly every action is the page's own — and it
/// then works in the Quick Look panel too, which has no menu bar and no toolbar at all.
export function createPalette({ actions, onRun }) {

  const root = document.createElement('div');
  root.id = 'palette';
  root.hidden = true;
  root.innerHTML = `
    <div class="palette-box">
      <input class="palette-input" type="text" placeholder="Search actions…"
             autocomplete="off" spellcheck="false">
      <div class="palette-list"></div>
    </div>`;
  document.body.appendChild(root);

  const input = root.querySelector('.palette-input');
  const list = root.querySelector('.palette-list');
  let matches = [];
  let active = 0;

  /// Substring matching, ranked so a word that *starts* with the query wins.
  /// Deliberately not fuzzy: with a couple of dozen actions, fuzzy matching mostly produces
  /// surprises — "to" should find Top, not Restore all.
  function score(action, query) {
    const title = action.title.toLowerCase();
    const group = (action.group ?? '').toLowerCase();
    if (!query) return 1;
    const at = title.indexOf(query);
    if (at === 0) return 100;
    if (at > 0) return title[at - 1] === ' ' ? 80 : 40;
    return group.includes(query) ? 20 : 0;
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    matches = actions()
      .filter((a) => a.enabled === undefined || a.enabled())
      .map((a) => ({ action: a, rank: score(a, query) }))
      .filter((m) => m.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .map((m) => m.action);

    active = Math.min(active, Math.max(matches.length - 1, 0));
    list.textContent = '';

    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'No matching action';
      list.appendChild(empty);
      return;
    }

    matches.forEach((action, index) => {
      const row = document.createElement('button');
      row.className = 'palette-row' + (index === active ? ' is-active' : '');
      row.innerHTML = `<span class="palette-group">${action.group ?? ''}</span>
                       <span class="palette-title"></span>
                       <span class="palette-key">${action.shortcut ?? ''}</span>`;
      row.querySelector('.palette-title').textContent = action.title;
      row.addEventListener('mousemove', () => { active = index; paint(); });
      row.addEventListener('click', () => run(action));
      list.appendChild(row);
    });
  }

  /// Only the highlight changes as you arrow through, so the list is not rebuilt each time.
  function paint() {
    list.querySelectorAll('.palette-row').forEach((row, index) => {
      row.classList.toggle('is-active', index === active);
    });
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function run(action) {
    close();
    action.run();
    onRun?.(action);
  }

  function open() {
    if (!root.hidden) return;
    root.hidden = false;
    input.value = '';
    active = 0;
    render();
    input.focus();
  }

  function close() {
    root.hidden = true;
    input.blur();
  }

  input.addEventListener('input', () => { active = 0; render(); });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); event.preventDefault(); return; }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      active = Math.min(active + 1, matches.length - 1); paint(); event.preventDefault();
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      active = Math.max(active - 1, 0); paint(); event.preventDefault();
    } else if (event.key === 'Enter' && matches[active]) {
      run(matches[active]); event.preventDefault();
    }
  });

  // Clicking the backdrop dismisses; clicking inside the box must not.
  root.addEventListener('mousedown', (event) => { if (event.target === root) close(); });

  return { open, close, toggle: () => (root.hidden ? open() : close()), get isOpen() { return !root.hidden; } };
}
