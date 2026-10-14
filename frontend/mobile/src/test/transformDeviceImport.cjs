/** Transform only the device helper's lazy SDK import for the CommonJS Jest VM. */
module.exports = function transformDeviceImport({ types }) {
  return {
    name: 'test-device-notifications-import',
    visitor: {
      Import(path, state) {
        const call = path.parentPath
        if (!call.isCallExpression() || call.node.arguments[0]?.value !== 'expo-notifications') return
        const namespace = types.callExpression(state.file.addHelper('interopRequireWildcard'), [
          types.callExpression(types.identifier('require'), [types.stringLiteral('expo-notifications')]),
        ])
        call.replaceWith(types.callExpression(
          types.memberExpression(types.callExpression(
            types.memberExpression(types.identifier('Promise'), types.identifier('resolve')), [],
          ), types.identifier('then')),
          [types.arrowFunctionExpression([], namespace)],
        ))
      },
    },
  }
}
