/// The model's pieces, grouped the way the design was written, each one able to be switched
/// off and back on.
///
/// OpenSCAD keeps no names — a module leaves no trace in the CSG dump — but the *shape* of the
/// tree survives, and each piece knows the path it sits on. Chains with nothing to choose
/// between are folded away, so a group in this list is a place where the design actually
/// branched rather than every anonymous wrapper between here and the root.
export function createTree({ container, onToggle, isHidden, label }) {

  let roots = [];
  const collapsed = new Set();          // group keys the user folded shut
  let panelOpen = true;

  /// Builds the group tree from the pieces' paths.
  function build(components) {
    const root = { key: '', children: new Map(), pieces: [] };

    for (const component of components) {
      let node = root;
      for (const step of component.path ?? []) {
        const key = node.key ? `${node.key}.${step}` : String(step);
        if (!node.children.has(key)) {
          node.children.set(key, { key, children: new Map(), pieces: [] });
        }
        node = node.children.get(key);
      }
      node.pieces.push(component);
    }

    // A group with one child and nothing of its own is not a choice — fold it away, or the
    // list would be a hundred rows deep before reaching a single piece.
    function fold(node) {
      let current = node;
      while (current.children.size === 1 && current.pieces.length === 0) {
        current = [...current.children.values()][0];
      }
      current.children = new Map([...current.children].map(([k, v]) => [k, fold(v)]));
      return current;
    }

    roots = [...fold(root).children.values()];
    if (!roots.length) roots = [fold(root)];
    return roots;
  }

  const pieces = (node) =>
    node.pieces.concat([...node.children.values()].flatMap(pieces));

  function render() {
    container.textContent = '';

    const header = document.createElement('button');
    header.className = 'tree-header';
    const total = roots.flatMap(pieces).length;
    header.innerHTML = `<span class="tree-caret">${panelOpen ? '▾' : '▸'}</span>
                        <span>Parts (${total})</span>`;
    header.addEventListener('click', () => { panelOpen = !panelOpen; render(); });
    container.appendChild(header);
    if (!panelOpen) return;

    const body = document.createElement('div');
    body.className = 'tree-body';
    container.appendChild(body);

    let group = 0;
    for (const node of roots) renderGroup(node, body, 0, () => ++group);
  }

  function renderGroup(node, into, depth, nextIndex) {
    const own = pieces(node);
    if (!own.length) return;

    // A group of one piece is that piece, whether it holds it directly or through wrappers —
    // a row that expands into a single row is noise.
    if (own.length === 1) return renderPiece(own[0], into, depth);

    const index = nextIndex();
    const isCollapsed = collapsed.has(node.key);
    const hiddenCount = own.filter((p) => isHidden(p.id)).length;

    const row = document.createElement('div');
    row.className = 'tree-row is-group';
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.innerHTML = `<button class="tree-caret">${isCollapsed ? '▸' : '▾'}</button>
                     <span class="tree-name">Group ${index} · ${own.length}</span>
                     <button class="tree-eye"></button>`;
    row.querySelector('.tree-caret').addEventListener('click', () => {
      if (isCollapsed) collapsed.delete(node.key); else collapsed.add(node.key);
      render();
    });

    const eye = row.querySelector('.tree-eye');
    eye.textContent = hiddenCount === own.length ? '􀋯' : '􀋮';
    eye.classList.toggle('is-off', hiddenCount === own.length);
    eye.title = hiddenCount === own.length ? 'Show all in group' : 'Hide all in group';
    // Partly hidden reads as "on", so one click takes the whole group away — the reverse
    // would need two clicks to do anything visible.
    eye.addEventListener('click', () => {
      onToggle(own.map((p) => p.id), hiddenCount === own.length);
    });
    into.appendChild(row);

    if (isCollapsed) return;
    for (const piece of node.pieces) renderPiece(piece, into, depth + 1);
    for (const child of node.children.values()) renderGroup(child, into, depth + 1, nextIndex);
  }

  function renderPiece(piece, into, depth) {
    const off = isHidden(piece.id);
    const row = document.createElement('div');
    row.className = 'tree-row' + (off ? ' is-off' : '');
    row.style.paddingLeft = `${6 + depth * 12 + 14}px`;
    row.innerHTML = `<span class="tree-name"></span><button class="tree-eye"></button>`;
    row.querySelector('.tree-name').textContent = label(piece);

    const eye = row.querySelector('.tree-eye');
    eye.textContent = off ? '􀋯' : '􀋮';
    eye.classList.toggle('is-off', off);
    eye.title = off ? 'Show' : 'Hide';
    eye.addEventListener('click', () => onToggle([piece.id], off));
    into.appendChild(row);
  }

  return {
    setComponents: (components) => { build(components); collapsed.clear(); render(); },
    refresh: render,
  };
}
