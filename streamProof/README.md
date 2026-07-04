# StreamProof

## Description

StreamProof est un plugin qui détecte automatiquement quand vous êtes en train de streamer et cache la section Equicord pour protéger votre vie privée.

## Fonctionnalités

- **Détection automatique du stream** : Le plugin surveille en temps réel votre statut de streaming avec 3 méthodes différentes
- **Masquage de la section Equicord** : Cache automatiquement tous les éléments Equicord/Vencord dans les paramètres
- **Masquage du bouton des paramètres** : Option pour cacher aussi le bouton Equicord dans la barre d'outils
- **Sélecteurs CSS personnalisés** : Possibilité d'ajouter vos propres sélecteurs CSS à masquer
- **Protection automatique** : S'active et se désactive automatiquement selon votre état de stream
- **Mode débogage** : Logs détaillés pour diagnostiquer les problèmes de détection

## Paramètres

### Cacher automatiquement la section Equicord pendant le stream
Active ou désactive le masquage de la section Equicord dans les paramètres.
- **Par défaut** : Activé

### Cacher aussi le bouton des paramètres Equicord
Cache également le bouton Equicord dans la barre d'outils supérieure.
- **Par défaut** : Activé

### Sélecteurs CSS personnalisés
Permet d'ajouter des sélecteurs CSS supplémentaires à masquer (séparés par des virgules).
- **Exemple** : `.ma-classe, #mon-id, [data-attribute="value"]`

### Mode débogage
Active les logs détaillés dans la console pour diagnostiquer les problèmes.
- **Par défaut** : Désactivé

## Utilisation

1. Activez le plugin dans les paramètres Equicord
2. Configurez les options selon vos besoins
3. Lancez un stream
4. Les éléments Equicord seront automatiquement masqués
5. Arrêtez le stream pour les afficher à nouveau

## Diagnostic

Si le plugin ne détecte pas votre stream :

1. Activez le **Mode débogage** dans les paramètres du plugin
2. Ouvrez la console (Ctrl+Shift+I)
3. Lancez un stream
4. Vérifiez les logs `[StreamProof]` pour comprendre ce qui se passe
5. Vous devriez voir "EN STREAM" dans les logs quand vous streamez

## Fonctionnement technique

Le plugin utilise :
- **3 méthodes de détection** :
  1. `StreamStore.getActiveStreamForUser()` - Détecte les streams de l'utilisateur actuel
  2. `StreamStore.getAllActiveStreams()` - Vérifie tous les streams actifs
  3. `RTCConnectionStore` - Vérifie l'état de connexion RTC pour le contexte "stream"
- L'injection dynamique de CSS pour masquer les éléments
- Le `FluxDispatcher` pour écouter 8 événements différents :
  - STREAM_CREATE, STREAM_UPDATE, STREAM_DELETE
  - STREAM_START, STREAM_STOP, STREAM_CLOSE
  - RTC_CONNECTION_STATE, MEDIA_ENGINE_VIDEO_STATE_UPDATE
- Une vérification périodique toutes les 2 secondes pour garantir la fiabilité

## Notes

- Le plugin s'arrête automatiquement lorsque vous arrêtez le stream
- Compatible avec tous les types de streams (caméra, écran, Go Live dans un canal vocal)
- N'affecte pas le fonctionnement d'Equicord, masque uniquement l'interface
- Les logs avec 🔒 indiquent que le masquage est actif
- Les logs avec 🔓 indiquent que le masquage est désactivé
