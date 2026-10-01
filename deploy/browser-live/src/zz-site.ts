import { createServer } from 'node:http';
// Like a projects app: sign in, a dialog to add a project (four fields, only the name required), an
// inline error when the name is empty, a toast with no ARIA role, and the new project on top of the list.
const projects: Array<{ id: number; name: string }> = [{ id: 1, name: 'Existing one' }];
const CSS = 'body{margin:0;font:16px sans-serif} .a{position:absolute} input,textarea,select{width:220px;height:28px} .card a{display:block;height:36px;line-height:36px;width:300px} .field-error{color:#c00;font-size:12px}';
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;
createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  const mod = u.pathname.match(/^\/api\/projects\/(\d+)\/modules$/);
  if (req.method === 'POST' && mod) {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      res.statusCode = 201; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: Date.now(), name: JSON.parse(body).name }));
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/projects') {
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(projects));
  }
  if (req.method === 'POST' && u.pathname === '/api/projects') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const p = JSON.parse(body);
      if (projects.some((x) => x.name.toLowerCase() === String(p.name).trim().toLowerCase())) {
        res.statusCode = 409; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'A project with this name already exists' }));
      }
      const id = Math.floor(Math.random() * 90000 + 10000); projects.unshift({ id, name: p.name });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id }));
    });
    return;
  }
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/login') return res.end(page('Sign in', `<form action="/home/projects" method="get">
    <input class="a" style="left:20px;top:20px" placeholder="Enter your email" name="email" type="email" required>
    <input class="a" style="left:20px;top:70px" placeholder="Enter your password" type="password">
    <button class="a" style="left:20px;top:120px;width:120px;height:32px">Sign in</button></form>
    <script>document.querySelector('form').onsubmit = () => { document.cookie = 'session=s' + Date.now() + '; path=/'; };</script>`));
  if (u.pathname === '/home/projects') return res.end(page('Projects', `<h1 class="a" style="left:20px;top:0">Projects</h1>
    <button class="a" id="newbtn" style="left:20px;top:80px;width:160px;height:30px">Add New Project</button>
    <div id="list" class="a card" style="left:20px;top:300px">${projects.map((p) => `<a href="/home/projects/${p.id}">${p.name}</a>`).join('')}</div>
    <div role="dialog" aria-label="New project" id="dlg" class="a" style="left:20px;top:130px;display:none;width:600px;height:160px">
      <input class="a" style="left:20px;top:10px" id="projname" placeholder="Enter your full project name" required maxlength="60">
      <span class="a field-error" id="nameerr" style="left:20px;top:42px;display:none">Project name is required</span>
      <label class="a" style="left:260px;top:10px">Description <textarea id="desc"></textarea></label>
      <label class="a" style="left:20px;top:60px">Due date <input type="date" id="due"></label>
      <label class="a" style="left:260px;top:60px">Priority <select id="pri"><option>Select</option><option>High</option><option>Low</option></select></label>
      <button class="a" id="add" style="left:20px;top:110px;width:100px;height:30px" disabled>Add</button>
      <input class="a" style="left:260px;top:110px" id="code" placeholder="Project code" required minlength="3" maxlength="10">
    </div>
    <script>
      fetch('/api/projects');
      newbtn.onclick = () => { dlg.style.display = 'block'; };
      // The form keeps Add off until the code is long enough.
      code.oninput = () => { add.disabled = code.value.trim().length < 3; };
      const toast = (text, bad) => { const t = document.createElement('div'); t.className = 'Toastify__toast' + (bad ? ' Toastify__toast--error' : ''); t.style.cssText = 'position:fixed;right:10px;top:10px;padding:10px;background:' + (bad ? '#fdd' : '#dfd'); t.innerHTML = '<span>' + text + '</span>'; document.body.appendChild(t); setTimeout(() => t.remove(), 4000); };
      add.onclick = async () => {
        if (!projname.value.trim()) { nameerr.style.display = 'block'; return; }  // refused: dialog stays, inline error
        nameerr.style.display = 'none';
        const r = await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ name: projname.value, code: code.value, desc: desc.value, due: due.value, pri: pri.value }) });
        if (!r.ok) return toast((await r.json()).error, true);  // refused by the server: dialog stays
        const { id } = await r.json();
        dlg.style.display = 'none';
        list.insertAdjacentHTML('afterbegin', '<a href="/home/projects/' + id + '">' + projname.value + '</a>');
        toast('Project ' + projname.value + ' created successfully');
      };
    </script>`));
  if (u.pathname.startsWith('/home/projects/')) return res.end(page('Project', `<h1 class="a" style="left:20px;top:0">Start by creating a module</h1>
    <button class="a" id="addmod" style="left:20px;top:80px;width:160px;height:30px">Add Module</button>
    <div role="dialog" aria-label="New module" id="mdlg" class="a" style="left:20px;top:130px;display:none;width:600px;height:100px">
      <input class="a" style="left:20px;top:10px" id="modname" placeholder="Module name" required maxlength="40">
      <span class="a field-error" id="moderr" style="left:20px;top:42px;display:none">Module name is required</span>
      <button class="a" id="savemod" style="left:20px;top:60px;width:120px;height:30px">Save module</button>
    </div>
    <div id="mods" class="a card" style="left:20px;top:260px"></div>
    <script>
      addmod.onclick = () => { mdlg.style.display = 'block'; };
      savemod.onclick = async () => {
        if (!modname.value.trim()) { moderr.style.display = 'block'; return; }
        moderr.style.display = 'none';
        const id = location.pathname.split('/').pop();
        const r = await fetch('/api/projects/' + id + '/modules', { method: 'POST', body: JSON.stringify({ name: modname.value }) });
        if (!r.ok) return;
        mdlg.style.display = 'none';
        localStorage.setItem('lastModule', modname.value);
        mods.insertAdjacentHTML('afterbegin', '<a href="#">' + modname.value + '</a>');
        const t = document.createElement('div'); t.className = 'Toastify__toast'; t.style.cssText = 'position:fixed;right:10px;top:10px;padding:10px;background:#dfd';
        t.innerHTML = '<span>Module ' + modname.value + ' added</span>'; document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
      };
    </script>`));
  res.statusCode = 404; res.end('no');
}).listen(4555, () => console.log('site up'));
