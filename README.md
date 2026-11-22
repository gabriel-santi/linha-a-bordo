# Linha a bordo

Editor de bordado em ponto cruz. O navegador salva o bordado automaticamente.

1. Instale o Node.js 22 (versão 22.12.0 ou posterior da série 22), que inclui o npm.
2. Na raiz do repositório, execute `npm ci`.
3. Execute `npm run dev` e abra no navegador a URL exibida pelo Vite.

## Camadas e histórico

- Cada bordado começa com uma camada vazia. **Nova camada** acrescenta uma camada no topo e a seleciona. A lista mostra a ordem do topo à base. Selecione uma camada para pintar ou apagar nela, ou use as setas **Subir camada** e **Descer camada** para alterar a ordem. Os botões só com ícone mostram o nome ao passar o mouse ou ao receber o foco pelo teclado.
- Pontos vazios deixam aparecer as camadas inferiores. Branco é uma tinta e cobre o que está abaixo quando a opacidade está em 100%. **Opacidade** de 0% a 100% regula quanto da tinta aparece. **Visível** mostra ou oculta a camada sem apagar seus pontos. Mostre uma camada oculta antes de editar.
- **Excluir camada** (lixeira) pede confirmação se a camada contiver pontos pintados, inclusive quando estiver oculta ou com opacidade de 0%. O bordado mantém pelo menos uma camada.
- **Ctrl+Z** desfaz e **Ctrl+Y** refaz pintura, borracha, criação, importação de imagem, exclusão, ordem, opacidade, visibilidade e redimensionamento. Um traço ou um arraste no controle de opacidade conta como uma ação. Selecionar outra camada não cria uma ação. O histórico é da sessão de edição do bordado aberto.
- A biblioteca salva as camadas e a seleção ativa com o bordado. Bordados anteriores abrem com o desenho em uma camada.

## Importação de imagem

- **Importar imagem**, no painel de camadas, abre um arquivo local PNG, JPEG ou WebP. A conversão acontece no próprio navegador, sem enviar a imagem a nenhum serviço. Um arquivo de outro formato, vazio ou corrompido mostra uma mensagem e não altera o bordado, as camadas nem o histórico.
- A imagem inteira é encaixada na grade atual, centralizada e com a proporção mantida, sem cortar nem distorcer a imagem e sem mudar as dimensões do bordado. O lado limitante ocupa a grade toda; o outro é arredondado ao inteiro mais próximo (meio ponto para cima), fica entre 1 e o tamanho da grade, e a sobra é dividida ao meio, com o ponto ímpar à direita ou embaixo. As sobras ficam vazias.
- A redução usa um único método, **média por área**: cada ponto recebe a média das cores dos pixels que ele cobre, ponderada pela área coberta, inclusive frações de pixel. Depois, cada ponto recebe a cor mais próxima entre as 14 cores fixas da paleta, pela menor distância euclidiana ao quadrado em RGB; num empate vence a cor que vem primeiro na paleta. Não há dithering, paleta gerada nem cores adicionais.
- A redução pode perder parte de traços finos e mudar a cor dos pontos em que eles se misturam ao fundo. Grades maiores preservam mais detalhes, mas nenhum tamanho garante que todo traço fique distinguível.
- Pixels totalmente transparentes viram pontos vazios; um ponto só fica vazio se todos os pixels que ele cobre forem totalmente transparentes. Pixels semitransparentes são combinados com branco antes da média. Branco é tinta branca. Não há remoção automática de fundo.
- A prévia abre com a composição das camadas visíveis e a imagem convertida no topo; **Somente a nova camada** mostra só o resultado da conversão. **Escolher outro arquivo** descarta a conversão anterior. **Confirmar importação** acrescenta uma camada no topo, visível, com opacidade de 100% e selecionada, pronta para pintar e apagar. **Cancelar** ou **Esc** fecha a prévia sem alterar o bordado, inclusive durante a conversão.
- Um **Ctrl+Z** desfaz a importação inteira e restaura a camada selecionada antes dela; **Ctrl+Y** a refaz. A camada importada é salva com o bordado e entra no PNG como as demais.

## Dimensões do bordado

- Ao criar um bordado, dê um nome e informe a largura e a altura em pontos. Cada eixo aceita inteiros de 1 a 200 e começa em 60.
- Use **Redimensionar** no bordado aberto. Os pontos mantêm suas coordenadas a partir do canto superior esquerdo e as áreas acrescentadas ficam vazias. A redução pede confirmação se cortar algum ponto pintado em qualquer camada, inclusive branco, em camada oculta ou com opacidade de 0%.
- Desfazer um redimensionamento restaura as dimensões e os pontos cortados de todas as camadas.
- **Baixar PNG** exporta a grade inteira a 20 pixels por ponto em cada eixo, com as camadas visíveis na ordem e opacidade atuais sobre fundo branco, independentemente da camada selecionada, do zoom e da rolagem. Um bordado de 80 × 70 pontos gera um PNG de 1600 × 1400 pixels.
