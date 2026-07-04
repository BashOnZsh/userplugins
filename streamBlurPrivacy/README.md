# Stream Blur Privacy

## Description

Stream Blur Privacy est un plugin Discord qui floute automatiquement tous les messages, images, liens et contenus dans les conversations privées sélectionnées lorsque vous streamez. Cela garantit votre confidentialité en cachant les informations sensibles des spectateurs de votre stream.

## Fonctionnalités

- **Floutage sélectif des conversations** : Choisissez quelles conversations MP flouter via le menu contextuel (clic droit)
- **Détection automatique du stream** : Détecte automatiquement quand vous commencez/arrêtez un stream pour appliquer le flou
- **Paramètres persistants** : Vos préférences de floutage sont sauvegardées et restaurées après redémarrage
- **Contrôle manuel et automatique** : Fonctionne en automatique pendant les streams et peut aussi être contrôlé manuellement
- **Intensité de flou personnalisable** : Ajustez l'intensité du flou de 1 à 30 pixels (par défaut: 10px)
- **Faible impact sur les performances** : Utilise le flou CSS au lieu de la manipulation du DOM
- **Mode debug** : Enregistrement optionnel dans la console pour le dépannage

## Installation

1. Placez ce dossier dans votre répertoire de plugins Vencord : `src/userplugins/streamBlurPrivacy/`
2. Rechargez Discord ou lancez l'injecteur de plugins
3. Activez le plugin dans les paramètres de Vencord

## Utilisation

### Activer le floutage pour une conversation

1. Ouvrez un message privé ou un groupe privé
2. Faites un clic droit sur le nom de la conversation
3. Sélectionnez "Stream blur: OFF - [Nom de la conversation]"
4. La conversation est maintenant marquée pour le floutage

### Commencer un stream

Une fois qu'une conversation est marquée pour le floutage :
1. Lancez un stream sur Discord (partage d'écran)
2. Tous les messages, images, liens et contenus de cette conversation seront automatiquement floutés
3. Le floutage reste actif jusqu'à ce que vous arrêtiez le stream ou désactiviez le plugin

### Désactiver le floutage pour une conversation

1. Faites de nouveau un clic droit sur la conversation
2. Sélectionnez "Stream blur: ON - [Nom de la conversation]" pour désactiver le floutage
3. Tout le contenu redevient immédiatement visible

## Paramètres

### Intensité du floutage
- **Type** : Curseur numérique (1-30 pixels)
- **Défaut** : 10 pixels
- **Description** : Contrôle la force de l'effet de floutage. Les valeurs plus élevées = flou plus fort

### Floutage automatique au stream
- **Type** : Interrupteur booléen
- **Défaut** : Activé
- **Description** : Si activé, le floutage s'applique automatiquement lors du stream si la conversation est marquée

### Afficher les notifications
- **Type** : Interrupteur booléen
- **Défaut** : Activé
- **Description** : Affiche des messages de notification lors de l'activation/désactivation du floutage

### Mode debug
- **Type** : Interrupteur booléen
- **Défaut** : Désactivé
- **Description** : Active l'enregistrement détaillé en console pour dépanner la détection du stream et les changements d'état

## Détails techniques

### Comment ça fonctionne

1. **Détection du stream** : Surveille l'état du stream Discord via plusieurs méthodes :
   - API StreamStore (méthode principale)
   - État de la connexion RTC (méthode secondaire)
   - Vérification de sécurité périodique toutes les 2 secondes

2. **Injection CSS** : Lorsque vous streamez et qu'une conversation est marquée pour le floutage :
   - Injecte un élément `<style>` dynamique avec les règles CSS de floutage
   - Cible les conteneurs de messages par ID unique
   - Applique `filter: blur(Xpx)` à tout le texte, les images, les liens et les intégrations

3. **Gestion de l'état** :
   - Stocke les IDs des canaux floutés dans le DataStore de Vencord
   - Charge les paramètres persistés au démarrage du plugin
   - Sauvegarde les modifications immédiatement lors du basculement du floutage

4. **Surveillance des événements Flux** :
   - `STREAM_CREATE`/`STREAM_START` : Détecte le début du stream
   - `STREAM_STOP`/`STREAM_DELETE` : Détecte la fin du stream
   - `CHANNEL_SELECT` : Détecte les changements de conversation
   - Intervalle de sécurité (2s) : Détection de fallback du stream

### Stratégie des sélecteurs CSS

Le plugin cible uniquement les messages de la liste de messages du chat en utilisant :
```css
ol[data-list-id="chat-messages"] div[id*="message-content"],
ol[data-list-id="chat-messages"] div[id*="message-accessories"],
ol[data-list-id="chat-messages"] div[role="article"]
```

Cela garantit :
- Seules les conversations spécifiées sont affectées
- Tous les types de contenu de messages sont floutés
- Aucun impact sur les autres conversations ou l'interface Discord

## Dépannage

### Le floutage ne s'applique pas lors du stream

1. **Vérifiez que la conversation est marquée** : Le menu clic droit devrait afficher "Stream blur: ON"
2. **Activez le mode debug** :
   - Allez dans les paramètres du plugin
   - Activez "Mode debug"
   - Ouvrez les DevTools (Ctrl+Shift+I)
   - Vérifiez les logs `[StreamBlurPrivacy]` dans la console
3. **Vérifiez la détection du stream** :
   - La console devrait afficher "Stream détecté" quand vous streamez
   - Si non détecté, la détection du stream peut échouer
4. **Redémarrez le plugin** : Désactivez et réactivez le plugin

### Les paramètres ne persistent pas après redémarrage

1. Vérifiez que "Stream Blur Privacy" est activé dans les plugins Vencord
2. Vérifiez que le stockage du navigateur n'est pas effacé à la fermeture
3. Essayez de basculer de nouveau le floutage sur une conversation (doit re-sauvegarder)

### Problèmes de performance

1. Réduisez l'intensité du floutage
2. Floutez moins de conversations
3. Vérifiez qu'aucun autre plugin n'entre en conflit avec le rendu des messages

## Exemples de logs console

### Mode debug activé

```
[StreamBlurPrivacy 14:23:45] Chargement de 3 conversations floutées
[StreamBlurPrivacy 14:23:47] Conversation changée : null -> 123456789
[StreamBlurPrivacy 14:23:50] Stream détecté via getActiveStreamForUser
[StreamBlurPrivacy 14:23:50] CSS de floutage injecté pour le canal 123456789 avec intensité 10px
[StreamBlurPrivacy 14:25:15] Événement STREAM_STOP
[StreamBlurPrivacy 14:25:15] CSS de floutage supprimé pour le canal 123456789
```

## Limitations

- N'affecte que les conversations DM et Group DM (pas les serveurs)
- L'effet de floutage est visuel uniquement (ne bloque pas l'accès du lecteur d'écran au contenu)
- Les performances dépendent des performances de rendu des messages de Discord
- Ne floute pas les avatars ou les noms d'utilisateur (seulement le contenu des messages)

## Note de confidentialité

Ce plugin offre une confidentialité visuelle pendant les streams mais ne doit pas être la seule mesure de confidentialité. Considérez :
- Utiliser les paramètres de qualité de stream natifs de Discord
- Surveiller ce qui est visible sur votre écran
- Être conscient de ce qui s'affiche dans votre barre des tâches/notifications
- Utiliser un filtre de confidentialité physique si nécessaire

## FAQ

### Ça fonctionne sur les serveurs ?

Non, actuellement supporté uniquement pour les canaux DM et Group DM. Le support des serveurs pourrait être ajouté dans les futures versions.

### Est-ce que mes propres messages seront floutés ?

Oui, si vous êtes dans une conversation floutée pendant que vous streamez, vos propres messages seront également floutés. C'est intentionnel pour une confidentialité complète.

### Puis-je flouter plusieurs conversations ?

Oui, vous pouvez faire un clic droit et activer le floutage sur autant de conversations que vous le souhaitez. Chacune est sauvegardée indépendamment.

### Quels formats sont floutés ?

- Messages texte
- Images et intégrations d'images
- Liens et intégrations de liens
- Contenu vidéo
- Intégrations étendues (YouTube, etc.)

---

**Dernière mise à jour** : Avril 2026 - Optimisation des sélecteurs CSS et traduction en français

### Is the blur saved after I close Discord?

Yes, the list of blurred conversations is saved to Vencord's DataStore and automatically loaded when Discord starts.

### Can I blur without streaming?

Currently, blur only applies during active streams. You can request manual blur mode in plugin settings if needed.

### How intensive is this on my CPU?

CSS-based blur is very efficient. The performance impact is minimal, even with multiple conversations blurred.
