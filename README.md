# Plugins Utilisateurs Equicord/Vencord

Ce dépôt contient des plugins utilisateurs pour Equicord et Vencord.

## Prérequis

Avant de commencer, assurez-vous d'avoir installé les outils suivants :

- **Git** (pour cloner les dépôts) : [Windows](https://gitforwindows.org/) | [macOS](https://git-scm.com/download/mac) | [Linux](https://git-scm.com/download/linux)
- **Node.js** (environnement d'exécution) : [Télécharger (Toutes plateformes)](https://nodejs.org/fr/download/)
- **pnpm** (gestionnaire de paquets) : [Instructions d'installation](https://pnpm.io/fr/installation)

## Comment les utiliser

**Important :** Vous devez obligatoirement avoir le code source de Vencord ou Equicord en local pour que cela fonctionne. Si ce n'est pas encore fait, vous devez d'abord cloner leur dépôt à l'aide des commandes suivantes :
- Pour Vencord : `git clone https://github.com/Vendicated/Vencord`
- Pour Equicord : `git clone https://github.com/Equicord/Equicord`

1. Clonez ou téléchargez ce dépôt (celui qui contient les plugins).
2. Allez dans le répertoire du code source de votre client (Equicord ou Vencord). *(Il s'agit du dossier où vous l'avez cloné, par exemple :)*
   - **Windows** : `C:\Users\VotreUser\Vencord` (ou `Equicord`)
   - **macOS** : `~/Vencord` (ou `Equicord`)
   - **Linux** : `~/Vencord` (ou `Equicord`)
3. Placez les dossiers ou fichiers des plugins que vous souhaitez utiliser dans le dossier `src/userplugins` (s'il n'existe pas, créez-le).
4. Ouvrez un terminal dans le répertoire de votre client.
   - **Note pour Windows :** En cas d'erreur liée aux politiques d'exécution des scripts, ouvrez PowerShell en tant qu'administrateur et exécutez `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`.
5. Installez les dépendances du projet :
   ```sh
   pnpm install
   ```
6. Recompilez le client pour intégrer les plugins :
   ```sh
   pnpm build
   ```
7. Fermez complètement votre client Discord (assurez-vous qu'il ne tourne plus en arrière-plan).
8. Injectez le client dans votre application Discord :
   - **Windows / macOS** :
     ```sh
     pnpm inject
     ```
   - **Linux** (nécessite souvent les droits administrateur) :
     ```sh
     sudo pnpm inject
     ```
9. Relancez votre client Discord. Les changements seront désormais appliqués.

## Bashcord

Un grand merci à toutes les personnes qui ont utilisé Bashcord. Je n'ai plus l'envie ni le temps de le maintenir, car je souhaite me reconcentrer sur le pentest et le reverse engineering.

## Crédits

Ce projet est conçu pour fonctionner avec :
- [Vencord](https://github.com/Vendicated/Vencord)
- [Equicord](https://github.com/Equicord/Equicord)

## Avertissement

L'utilisation de clients Discord modifiés et de plugins tiers va à l'encontre des conditions d'utilisation (Terms of Service) de Discord. Vous utilisez ces outils à vos propres risques. Pour plus de détails, veuillez consulter les [Conditions d'utilisation de Discord](https://discord.com/terms).

<div align="center">
  <img src="https://media.tenor.com/T4R8ZFMxcnEAAAAM/fishsticks-fish.gif" alt="fish" />
</div>
