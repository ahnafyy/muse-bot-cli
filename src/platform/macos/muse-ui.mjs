function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function walk(node, parent = null, entries = []) {
  if (!node) {
    return entries;
  }
  const entry = { node, parent };
  entries.push(entry);
  for (const child of node.children ?? []) {
    walk(child, entry, entries);
  }
  return entries;
}

function descendants(node) {
  return walk(node).map(({ node: descendant }) => descendant);
}

function staticText(node) {
  return descendants(node)
    .filter((descendant) => descendant.role === 'AXStaticText')
    .map((descendant) => text(descendant.value))
    .filter(Boolean);
}

function hasControl(node, title) {
  return descendants(node).some((descendant) =>
    ['AXButton', 'AXPopUpButton'].includes(descendant.role) && text(descendant.title) === title);
}

function isTimestamp(value) {
  return /^(?:[A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2} [AP]M|Today at \d{1,2}:\d{2} [AP]M)$/.test(value);
}

export function currentAgentFromSnapshot(snapshot) {
  for (const { node } of walk(snapshot)) {
    const children = node.children ?? [];
    const composerIndex = children.findIndex((child) =>
      child.role === 'AXButton' && /\bMessage\b/.test(text(child.title)) && /\bSend\b/.test(text(child.title)));
    if (composerIndex < 0) {
      continue;
    }

    const candidates = children
      .slice(composerIndex + 1)
      .filter((child) => child.role === 'AXButton' && text(child.title).length > 0)
      .map((child) => text(child.title));
    if (candidates.length > 0) {
      const duplicate = candidates.find((candidate, index) => candidates.indexOf(candidate) !== index);
      return duplicate ?? candidates[0];
    }
  }

  return expandedAgentFromSnapshot(snapshot)?.name ?? null;
}

function expandedAgentFromSnapshot(snapshot) {
  for (const { node } of walk(snapshot)) {
    const labels = (node.children ?? [])
      .filter((child) => child.role === 'AXStaticText')
      .map((child) => text(child.value))
      .filter(Boolean);
    const status = labels.find((label) => ['Connected', 'Disconnected'].includes(label));
    const name = labels.find((label) => label !== status);
    if (name && status) {
      return { name, status: status.toLowerCase() };
    }
  }
  return null;
}

export function agentsFromSnapshot(snapshot) {
  const expanded = expandedAgentFromSnapshot(snapshot);
  const name = currentAgentFromSnapshot(snapshot);
  return name ? [{ name, current: true, status: expanded?.name === name ? expanded.status : null }] : [];
}

function messageFromNode(node) {
  const values = staticText(node);
  if (values.length === 0 || values.every(isTimestamp)) {
    return null;
  }

  const prefixed = values.find((value) => /^(?:User|Assistant) message:/.test(value));
  if (prefixed) {
    const [, role, content] = prefixed.match(/^(User|Assistant) message:\s*(.*)$/s);
    return { role: role.toLowerCase(), content };
  }

  if (values[0] === 'You:') {
    return { role: 'user', content: values.slice(1).join('\n') };
  }

  if (hasControl(node, 'Reply') || hasControl(node, 'Copy response')) {
    return { role: 'assistant', content: values.join(' ') };
  }

  return null;
}

function lowestCommonAncestor(entries) {
  if (entries.length === 0) {
    return null;
  }
  const chains = entries.map((entry) => {
    const chain = [];
    for (let current = entry; current; current = current.parent) {
      chain.unshift(current);
    }
    return chain;
  });
  let ancestor = null;
  for (let index = 0; index < Math.min(...chains.map((chain) => chain.length)); index += 1) {
    if (chains.every((chain) => chain[index].node === chains[0][index].node)) {
      ancestor = chains[0][index];
    } else {
      break;
    }
  }
  return ancestor;
}

export function currentChatFromSnapshot(snapshot) {
  const entries = walk(snapshot);
  const chatContainer = entries.find(({ node }) => text(node.title) === 'Chat messages')?.node;
  if (chatContainer) {
    const messages = (chatContainer.children ?? [])
      .map(messageFromNode)
      .filter((message) => message && message.content.length > 0);
    if (messages.length > 0) {
      return messages;
    }
  }
  const markers = entries.filter(({ node }) => {
    const value = text(node.value);
    return node.role === 'AXStaticText' && (value === 'You:' || /^(?:User|Assistant) message:/.test(value));
  });
  if (markers.length === 1) {
    const message = messageFromNode(markers[0].node);
    return message ? [message] : [];
  }
  const container = lowestCommonAncestor(markers)?.node;
  if (!container) {
    return [];
  }

  return (container.children ?? [])
    .map(messageFromNode)
    .filter((message) => message && message.content.length > 0);
}

export function currentMuseUi(snapshot) {
  const messages = currentChatFromSnapshot(snapshot);
  const generating = walk(snapshot).some(({ node }) =>
    node.role === 'AXButton' && /\bMessage\b/.test(text(node.title)) && /\bStop\b/.test(text(node.title)));
  const lastRole = messages.at(-1)?.role ?? null;
  return {
    agent: currentAgentFromSnapshot(snapshot),
    agents: agentsFromSnapshot(snapshot),
    messages,
    status: generating ? 'running' : lastRole === 'user' ? 'waiting' : lastRole === 'assistant' ? 'completed' : 'empty',
  };
}