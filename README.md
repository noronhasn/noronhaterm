# NetDeck

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

Sem instalar nada no PC: no GitHub, aba **Actions → Build → Run workflow** gera os instaladores de **Windows** e de **Linux** (artefatos `netdeck-windows` e `netdeck-linux`).

### Linux

- `.deb` (Ubuntu/Debian): `sudo apt install ./NetDeck-0.4.7.deb`
- AppImage: `chmod +x NetDeck-0.4.7.AppImage && ./NetDeck-0.4.7.AppImage`. O atalho do `.deb` já abre com `--no-sandbox` (o Ubuntu 22.04+ bloqueia o modo de segurança do Electron e o app fechava ao clicar no ícone). No AppImage, se não abrir, use `./NetDeck-0.4.7.AppImage --no-sandbox`.
- Portas abaixo de 1024 (TFTP 69, FTP 21) exigem root no Linux: nos servidores embutidos use portas altas (ex.: 6969 e 2121).
- Serial: seu usuário precisa estar no grupo `dialout` (`sudo usermod -aG dialout $USER`, depois sair e entrar).


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
| Backup automático | menu ⋯ → *Backup automático do cofre*: copia os cofres (já criptografados) para uma pasta à sua escolha, como a do Google Drive para computador, OneDrive ou Dropbox. Você define a frequência (minutos, horas ou dias) e quantos backups manter. Roda enquanto o app está aberto |
| Servidores TFTP e FTP | menu ⋯ → *Servidores TFTP / FTP*: pasta raiz à escolha, liga/desliga por botão, TFTP com blksize/tsize, FTP com usuário e senha (passivo e ativo), somente leitura opcional, log de atividade. Sem dependências externas; tudo preso à pasta raiz |
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

## Restaurar backup
Em **⋯ → Restaurar backup do cofre…** escolha o arquivo `.vault` (por exemplo, o baixado do Drive) e informe a senha mestra que valia naquele backup. O cofre atual é substituído e uma cópia dele fica guardada na pasta de dados.

## Log de sessão
Em **⋯ → Log de sessão…** ligue a gravação. Cada conexão aberta depois disso gera um arquivo `<host>_AAAAMMDD-HHMMSS.log` (sem cores nem códigos de controle, com a opção de hora em cada linha) na pasta escolhida (padrão: `Documentos\NetDeck\logs`). O log mostra o que apareceu no terminal; guarde a pasta com cuidado, pois pode conter configurações dos equipamentos.

## Versão Android (0.5.1)

App Android (APK) com SSH, Telnet, pastas/hosts, cofre criptografado, múltiplas abas, jump host e port forward local.
**Não inclui:** Serial, servidores FTP/TFTP, SFTP, log de sessão, backup automático e SOCKS5.

- Gerar: GitHub → Actions → Build → Run workflow → artefato `netdeck-android` (`NetDeck-Android-0.5.1.apk`).
- Instalar: copie o APK para o celular e permita "instalar de fontes desconhecidas".
- O cofre fica dentro do app. Use *Opções → Backup do cofre* para guardar uma cópia; o arquivo é o mesmo formato do desktop.
- Se o Android encerrar o app em segundo plano, as sessões SSH caem.
