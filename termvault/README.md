# NoronhaTerm

Cliente de terminal para **Windows e Linux** com SSH, Telnet e Serial, cofre criptografado de chaves/senhas e pastas de hosts por usuário. Inspirado no Termius e no MobaXterm.

## Como rodar

Requer Node.js 20+.

```bash
npm install
npm start          # abre o app
npm test           # testes do núcleo (cofre, pastas, chaves, telnet)
npm run dist:win   # instalador Windows (rode no Windows)
npm run dist:linux # AppImage + deb (rode no Linux)
```

Na primeira vez, crie um usuário e uma senha mestra (mínimo 8 caracteres). Cada usuário tem o seu próprio cofre.

## O que já tem

| Recurso | Detalhes |
|---|---|
| SSH | senha, chave privada, ssh-agent / OpenSSH Agent (Windows), keyboard-interactive, verificação de host key (novo / alterado) |
| Equipamentos antigos | algoritmos legados (DH group1/group14-sha1, CBC, ssh-rsa/ssh-dss) aceitos por padrão, acrescentados ao fim da lista; dá para desligar por host |
| Jump host | encadeado (A → B → C), também herdável da pasta |
| Túneis | local (`L:8080:host:80`) e proxy SOCKS5 dinâmico (`D:1080`) por host |
| SFTP | navegador na aba SSH atual, baixar e enviar arquivos |
| Telnet | negociação IAC (ECHO, SGA, TTYPE, NAWS), Enter em CR+LF ou CR+NUL |
| Serial | baud, bits, paridade, stop bits, controle de fluxo, detecção de portas (COM / ttyUSB) |
| Cofre | senha mestra → scrypt → AES-256-GCM; gravação atômica; bloqueio automático após 15 min |
| Chaves | gerar Ed25519 / RSA (até 8192) / ECDSA P-256, P-384, P-521; importar OpenSSH, PEM e .ppk do PuTTY; copiar pública, fingerprint SHA256, instalar no servidor (ssh-copy-id embutido) |
| Identidades | usuário + senha e/ou chave, reutilizável em vários hosts |
| Pastas | árvore com subpastas, arrastar e soltar, herança de identidade / jump host / comandos iniciais |
| Painéis divididos | arraste um host da lista para dentro do terminal: nas bordas divide (esquerda/direita/em cima/embaixo), no centro abre nova aba. Botões ◫ e ⬒ dividem repetindo a conexão atual. Divisores arrastáveis, grade 2×2 etc. |
| Outros | busca, favoritos, tags, conexão rápida (`user@host:22`), conectar em toda a pasta, multi-exec, importar `~/.ssh/config`, exportar/importar JSON |

Atalhos: `Ctrl+Shift+C/V` copiar/colar, botão direito copia (se há seleção) ou cola, `Ctrl+Tab` troca de aba, `Ctrl+Shift+D` divide lado a lado, `Ctrl+Shift+E` divide empilhado, `Ctrl+Shift+W` fecha o painel (ou a aba, se for o último).

## Segurança

- Senhas e chaves privadas só existem em claro **na memória do processo principal**. A interface recebe apenas metadados (nome, fingerprint, "tem senha").
- O arquivo do cofre guarda os parâmetros do KDF e o salt como dados autenticados (AAD): adulterar qualquer byte invalida a abertura.
- `contextIsolation`, `sandbox` e CSP ativos; a interface nunca usa `innerHTML` com dados do usuário.
- O processo principal só aceita uma lista fixa de operações vindas da interface.
- Telnet **não é criptografado**: use só em rede confiável ou equipamentos legados.
- Cofres ficam em `%APPDATA%/termvault/vaults` (Windows) ou `~/.config/termvault/vaults` (Linux). A pasta mantém o nome antigo de propósito, para não perder dados de quem já usava a versão TermVault.
- Perdeu a senha mestra: não há recuperação.

## Estrutura

```
src/core/vault.js     cofre criptografado
src/core/keys.js      geração/importação de chaves, formato OpenSSH, fingerprint
src/core/store.js     pastas, hosts, identidades, herança, known hosts, import ssh_config
src/main/main.js      Electron (processo principal) e IPC
src/main/ssh.js       sessão SSH, jump, túneis, SFTP, ssh-copy-id
src/main/telnet.js    cliente Telnet
src/main/serial.js    sessão serial
src/renderer/         interface (xterm.js); layout.js = árvore de painéis
test/                 testes automatizados
```

## Ainda não tem (próximos passos)

- X11 forwarding e túneis remotos (`-R`)
- Chaves protegidas por passphrase na geração, FIDO2/YubiKey
- Sincronização entre dispositivos e pastas compartilhadas em equipe (exige backend e criptografia por chave pública)
- Reordenar itens da árvore arrastando (hoje ordena por nome)
- Importar sessões do PuTTY / MobaXterm
