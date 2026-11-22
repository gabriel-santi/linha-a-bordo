# Linha a bordo

Editor de bordado em ponto cruz. O navegador salva o bordado automaticamente.

1. Instale o Node.js 22 (versão 22.12.0 ou posterior da série 22), que inclui o npm.
2. Na raiz do repositório, execute `npm ci`.
3. Execute `npm run dev` e abra no navegador a URL exibida pelo Vite.

## Camadas e histórico

- Cada bordado começa com uma camada vazia. **Nova camada** acrescenta uma camada no topo e a seleciona. A lista mostra a ordem do topo à base. Selecione uma camada para pintar ou apagar nela, ou use **Subir** e **Descer** para alterar a ordem.
- Pontos vazios deixam aparecer as camadas inferiores. Branco é uma tinta e cobre o que está abaixo quando a opacidade está em 100%. **Opacidade** de 0% a 100% regula quanto da tinta aparece. **Visível** mostra ou oculta a camada sem apagar seus pontos. Mostre uma camada oculta antes de editar.
- **Excluir** pede confirmação se a camada contiver pontos pintados, inclusive quando estiver oculta ou com opacidade de 0%. O bordado mantém pelo menos uma camada.
- **Ctrl+Z** desfaz e **Ctrl+Y** refaz pintura, borracha, criação, exclusão, ordem, opacidade, visibilidade e redimensionamento. Um traço ou um arraste no controle de opacidade conta como uma ação. Selecionar outra camada não cria uma ação. O histórico é da sessão de edição do bordado aberto.
- A biblioteca salva as camadas e a seleção ativa com o bordado. Bordados anteriores abrem com o desenho em uma camada.

## Dimensões do bordado

- Ao criar um bordado, dê um nome e informe a largura e a altura em pontos. Cada eixo aceita inteiros de 1 a 200 e começa em 60.
- Use **Redimensionar** no bordado aberto. Os pontos mantêm suas coordenadas a partir do canto superior esquerdo e as áreas acrescentadas ficam vazias. A redução pede confirmação se cortar algum ponto pintado em qualquer camada, inclusive branco, em camada oculta ou com opacidade de 0%.
- Desfazer um redimensionamento restaura as dimensões e os pontos cortados de todas as camadas.
- **Baixar PNG** exporta a grade inteira a 20 pixels por ponto em cada eixo, com as camadas visíveis na ordem e opacidade atuais sobre fundo branco, independentemente da camada selecionada, do zoom e da rolagem. Um bordado de 80 × 70 pontos gera um PNG de 1600 × 1400 pixels.
