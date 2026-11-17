#!/bin/sh
# atualiza o cache de atalhos para o menu enxergar o NetDeck logo após instalar/atualizar
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true

# porta serial (USB-serial, console de switch/roteador) liberada para quem está logado na tela:
# "uaccess" dá acesso na hora ao usuário da sessão, sem grupo dialout e sem sair/entrar de novo
cat > /etc/udev/rules.d/70-netdeck-serial.rules <<'RULES'
# NetDeck: acesso às portas seriais USB para o usuário logado
SUBSYSTEM=="tty", KERNEL=="ttyUSB[0-9]*", TAG+="uaccess"
SUBSYSTEM=="tty", KERNEL=="ttyACM[0-9]*", TAG+="uaccess"
RULES
udevadm control --reload-rules >/dev/null 2>&1 || true
udevadm trigger --subsystem-match=tty --action=change >/dev/null 2>&1 || true
exit 0
