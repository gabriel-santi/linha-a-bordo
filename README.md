# Linha a bordo

Editor de bordado em ponto cruz. O navegador salva o bordado automaticamente.

1. Instale o Node.js 22 (versão 22.12.0 ou posterior da série 22), que inclui o npm.
2. Na raiz do repositório, execute `npm ci`.
3. Execute `npm run dev` e abra no navegador a URL exibida pelo Vite.

## Dimensões do bordado

- Ao criar um bordado, dê um nome e informe a largura e a altura em pontos. Cada eixo aceita inteiros de 1 a 200 e começa em 60.
- Use **Redimensionar** no bordado aberto. Os pontos mantêm suas coordenadas a partir do canto superior esquerdo e as áreas acrescentadas ficam vazias. A redução pede confirmação se cortar algum ponto pintado, inclusive branco.
- Use **Ctrl+Z** para desfazer e **Ctrl+Y** para refazer. Um redimensionamento conta como uma ação e inclui as dimensões e todos os pontos cortados. O histórico é da sessão de edição do bordado aberto.
- **Baixar PNG** exporta a grade inteira a 20 pixels por ponto em cada eixo, independentemente do zoom e da rolagem. Um bordado de 80 × 70 pontos gera um PNG de 1600 × 1400 pixels.
