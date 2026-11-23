package com.example.shop.common;

/** Java 21: a sealed hierarchy of records, read with switch patterns. */
public sealed interface Shape permits Shape.Circle, Shape.Rectangle, Shape.Square {
  record Circle(double radius) implements Shape {}

  record Rectangle(double width, double height) implements Shape {}

  record Square(double side) implements Shape {}

  static double area(Shape shape) {
    return switch (shape) {
      case Circle c -> Math.PI * c.radius() * c.radius();
      case Rectangle(double w, double h) when w == h -> w * w;
      case Rectangle r -> r.width() * r.height();
      case Square s -> s.side() * s.side();
    };
  }

  static String describe(Object value) {
    if (value instanceof Shape s && area(s) > 10) {
      return "large " + s.getClass().getSimpleName();
    }
    return """
        not a large shape: \
        %s""".formatted(value);
  }
}
