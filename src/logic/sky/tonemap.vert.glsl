// ShaderPass 的顶点着色器：three.js 的 ShaderMaterial 会自动声明
// position / uv 属性和 projectionMatrix / modelViewMatrix，
// 所以这里不需要（也不能）自己声明，写 GLSL1 即可。
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
