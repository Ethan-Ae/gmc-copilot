# GMC Copilot

## Produit
SaaS qui aide les marchands Shopify a passer la validation Google Merchant Center (GMC).
Il audite le site, les policies, les donnees produit, le feed et Merchant Center, puis
propose les corrections et une decision go/no-go avant la demande de review.

## Stack
- Next.js (App Router) + TypeScript + Tailwind
- Deploiement: Vercel (auto-deploy sur push main, preview sur PR)
- Moteur d'audit: Anthropic API. Le savoir metier GMC est dans docs/gmc-skill/

## Conventions
- UI en francais, code et commentaires en anglais.
- Un composant = un fichier, dans src/.
- Aucun secret dans le repo. Cles via variables d'environnement (.env.local en dev jamais commite, prod dans Vercel).
- Dans les textes generes pour les marchands: pas de tirets longs, utiliser "-".

## Domaine metier
La logique de conformite vient des fichiers dans docs/gmc-skill/ (SKILL.md + references).
Regle zero-invention (gmc-principles.md): ne jamais ajouter une claim non prouvee.
Si un fait n'est pas dans une policy ou un reglage, retirer la claim ou d'abord rendre le reglage vrai et visible.
Toujours verifier que la donnee a bien propage dans GMC avant de donner un go.

## Commandes
- Dev: npm run dev
- Build: npm run build
- Lint: npm run lint
