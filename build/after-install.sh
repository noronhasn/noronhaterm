#!/bin/sh
# atualiza o cache de atalhos para o menu enxergar o NetDeck logo após instalar/atualizar
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
