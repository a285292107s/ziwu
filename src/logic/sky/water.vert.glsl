// three.js 全屏三角形：几何体是 PlaneGeometry(2, 2)，
// 相机是 OrthographicCamera(-1, 1, 1, -1, 0, 1)，所以顶点位置直接就是
// 裁剪空间的 xy（z 交给相机，这里写 0 即可）。
//
// 注意 RawShaderMaterial 不会替我们声明属性，`position` 必须自己写。
in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
